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
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, `${request.id}.json`), JSON.stringify(request));
  return request;
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// The newest request of each agent in one session's steer folder, as
// Map<agentId, { id, text, at, state, reason }>. State is 'delivered' or 'failed'
// from the result file, else 'unclaimed' once the request is 30 s old, else
// 'pending'. Files older than 24 h are deleted, only inside this session's folder.
function readSteers(configDir, sessionId, now = Date.now()) {
  const dir = steerDir(configDir, sessionId);
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
    const file = path.join(dir, name);
    const body = m[3] ? null : readJson(file);
    let mtime = now;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const age = now - Math.min(mtime, typeof body?.at === 'number' ? body.at : mtime);
    if (age > STEER_KEEP_MS) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
      continue;
    }
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

module.exports = { writeSteerRequest, readSteers, UNCLAIMED_AFTER_MS, STEER_KEEP_MS };
