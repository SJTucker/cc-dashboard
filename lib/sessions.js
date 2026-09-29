'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Live sessions for the Today range. Claude Code sends its statusline command a
// cost block per session after every response, and bin/record-statusline hands
// it to recordSession below, which keeps one small snapshot file per session.
// The transcripts cannot supply these figures live: Claude Code writes its
// cost-state line only when a session ends or is cleared.

// A session id becomes a file name, so only these characters are accepted.
// That rules out path separators and "." or "..".
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// prune() deletes only names this module writes: a snapshot or its tmp file.
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}\.json(\.\d+)?$/;

// Snapshots older than this are deleted on the next write.
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

function expandHome(p) {
  return p.replace(/^~/, os.homedir());
}

// Same precedence as getRateLimitsPath in lib/limits.js.
function getSessionsDir() {
  if (process.env.LIVE_SESSIONS_DIR) return expandHome(process.env.LIVE_SESSIONS_DIR);
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), 'cc-dashboard', 'sessions');
  return path.join(os.homedir(), '.claude', 'cc-dashboard', 'sessions');
}

function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function projectName(input) {
  const dir = input.workspace?.project_dir || input.workspace?.current_dir || input.cwd;
  return typeof dir === 'string' && dir ? path.basename(dir) : null;
}

function prune(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!SNAPSHOT_NAME_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(file);
    } catch {
      // Another session pruned it first, or it is not ours to remove.
    }
  }
}

// input is the parsed JSON a Claude Code statusLine command receives on stdin.
// Writes <dir>/<session_id>.json when input has a safe session id and a cost
// block. The statusline hook runs in the background, so two renders of one
// session can finish out of order. cost.total_duration_ms only grows during a
// session, so a snapshot with a smaller value than the file on disk is skipped.
// Never throws: the statusline must render whatever happens here.
function recordSession(input, dir = getSessionsDir(), now = Date.now()) {
  try {
    const id = input?.session_id;
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return;
    const cost = input.cost;
    if (typeof cost?.total_cost_usd !== 'number' || !Number.isFinite(cost.total_cost_usd)) return;

    let lastActiveAt = now;
    try {
      lastActiveAt = fs.statSync(input.transcript_path).mtime.getTime();
    } catch {
      // No readable transcript: the write time is the best stamp there is.
    }

    const snapshot = {
      sessionId: id,
      lastActiveAt,
      project: projectName(input),
      model: typeof input.model?.display_name === 'string' ? input.model.display_name : null,
      costUsd: count(cost.total_cost_usd),
      durationMs: count(cost.total_duration_ms),
      apiDurationMs: count(cost.total_api_duration_ms),
      linesAdded: count(cost.total_lines_added),
      linesRemoved: count(cost.total_lines_removed),
    };

    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // No snapshot yet, or one caught mid-write.
    }
    if (typeof existing?.durationMs === 'number' && existing.durationMs > snapshot.durationMs) return;

    const tmp = `${file}.${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      return;
    }
    prune(dir, now);
  } catch {
    // An unwritable directory or an unexpected input shape: record nothing.
  }
}

module.exports = { SESSION_ID_PATTERN, getSessionsDir, recordSession };
