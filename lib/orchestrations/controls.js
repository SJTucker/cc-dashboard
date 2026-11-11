'use strict';

// The two writes the Orchestration tab makes. A steer is a request file the mod
// inside the orchestrator's session picks up and delivers with $.session.send; the
// mod answers with a result file next to it. Layout, under <cfg>/cc-dashboard/:
//   steer/<orchestrator session id>/<request id>.json         { id, agentId, task, text, at }
//   steer/<orchestrator session id>/<request id>.result.json  { id, delivered, reason?, at }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../files');
const { SESSION_ID_PATTERN } = require('../session-id');

// A request with no result after this long is reported as not picked up.
const UNCLAIMED_AFTER_MS = 30 * 1000;
// Request and result files older than this are deleted.
const STEER_KEEP_MS = 24 * 60 * 60 * 1000;
// The optional \.\d+ matches writeFileAtomic's temp name, <id>.json.<pid>, which a crash can leave behind.
const STEER_FILE = /^([A-Za-z0-9-]{1,64})(\.result)?\.json(\.\d+)?$/;

const steerDir = (configDir, sessionId) => path.join(configDir, 'cc-dashboard', 'steer', sessionId);

function writeSteerRequest(configDir, sessionId, { agentId, task, text }, now = Date.now()) {
  const request = { id: crypto.randomUUID(), agentId, task, text, at: now };
  const dir = steerDir(configDir, sessionId);
  // cleanSteerFolders can remove the empty folder between the mkdir and the write. Within
  // one process both calls are synchronous and cannot interleave, so this needs a second
  // server on the same config dir. Try again once.
  for (let attempt = 0; ; attempt++) {
    try {
      // A symlinked steer/ or steer/<id> would put the request outside the config folder.
      for (const folder of [path.dirname(dir), dir]) {
        let st = null;
        try {
          st = fs.lstatSync(folder);
        } catch {
          // Not created yet.
        }
        if (st && !st.isDirectory()) throw new Error(`${folder} is a symlink or not a directory`);
      }
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, `${request.id}.json`), JSON.stringify(request));
      return request;
    } catch (err) {
      if (err.code !== 'ENOENT' || attempt > 0) throw err;
    }
  }
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// Reads one steer file: its parsed body (null for a temp file or bad JSON). A file
// older than 24 h (by mtime, or by its request's `at` when that is earlier) is deleted
// and gives null. Anything that is not a regular file, a symlink included, is left
// alone and gives null. temp is true for a <id>.json.<pid> leftover, which is never parsed.
function readOrExpire(file, temp, now) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const body = temp ? null : readJson(file);
  const age = now - Math.min(st.mtimeMs, typeof body?.at === 'number' ? body.at : st.mtimeMs);
  if (age > STEER_KEEP_MS) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
    return null;
  }
  return { body };
}

// The newest request of each agent in one session's steer folder, as
// Map<agentId, { id, text, at, state, reason }>. State is 'delivered' or 'failed'
// from the result file, else 'unclaimed' once the request is 30 s old, else
// 'pending'. Files older than 24 h are deleted, only inside this session's folder.
function readSteers(configDir, sessionId, now = Date.now()) {
  const dir = steerDir(configDir, sessionId);
  // A symlinked steer/ or steer/<id> folder would send the 24 h cleanup into its target.
  for (const folder of [path.dirname(dir), dir]) {
    try {
      if (!fs.lstatSync(folder).isDirectory()) return new Map();
    } catch {
      return new Map();
    }
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return new Map();
  }
  const requests = [];
  const results = new Map();
  for (const name of names) {
    const m = STEER_FILE.exec(name);
    if (!m) continue;
    const read = readOrExpire(path.join(dir, name), Boolean(m[3]), now);
    const body = read?.body;
    if (!body) continue;
    if (m[2]) results.set(m[1], body);
    else if (typeof body.agentId === 'string' && typeof body.text === 'string' && typeof body.at === 'number') requests.push({ ...body, id: m[1] });
  }
  const out = new Map();
  for (const r of requests) {
    const have = out.get(r.agentId);
    if (have && have.at >= r.at) continue;
    const result = results.get(r.id);
    let state = 'pending';
    let reason = null;
    if (result) {
      state = result.delivered === true ? 'delivered' : 'failed';
      reason = typeof result.reason === 'string' ? result.reason : null;
    } else if (now - r.at > UNCLAIMED_AFTER_MS) {
      state = 'unclaimed';
    }
    out.set(r.agentId, { id: r.id, text: r.text, at: r.at, state, reason });
  }
  return out;
}

// Deletes the expired request, result and temp files of every folder in
// <cfg>/cc-dashboard/steer/ whose name is a session id, then removes each such folder
// that is empty. readSteers cleans only the folders of sessions in a discovered group.
// Symlinks, names outside STEER_FILE and folder names outside SESSION_ID_PATTERN are
// never touched, and nothing outside steer/ is read or deleted.
function cleanSteerFolders(configDir, now = Date.now()) {
  const root = path.join(configDir, 'cc-dashboard', 'steer');
  let folders;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return;
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const folder of folders) {
    if (!folder.isDirectory() || !SESSION_ID_PATTERN.test(folder.name)) continue;
    const dir = path.join(root, folder.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = entry.isFile() ? STEER_FILE.exec(entry.name) : null;
      if (m) readOrExpire(path.join(dir, entry.name), Boolean(m[3]), now);
    }
    try {
      fs.rmdirSync(dir); // fails unless the folder is empty
    } catch {
      // not empty, or already gone
    }
  }
}

module.exports = { writeSteerRequest, readSteers, cleanSteerFolders, UNCLAIMED_AFTER_MS, STEER_KEEP_MS };
