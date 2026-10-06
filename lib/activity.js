'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Live state of each session, written by the Claude Code mod (mod/hooks/register.ts)
// to <config dir>/cc-dashboard/activity/<session id>.json each time the state
// changes. This module reads those files and prunes old ones: readActivity deletes
// files whose mtime is older than PRUNE_AFTER_MS.
//
// The constants and expandHome below are copied from lib/sessions.js. lib/sessions.js
// will require this module, so requiring it back would create a require cycle.

// Copied from lib/sessions.js (SESSION_ID_PATTERN). A session id becomes a file name,
// so only these characters are accepted.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Same shape as SNAPSHOT_NAME_PATTERN in lib/sessions.js. readActivity deletes only
// names the mod writes.
const ACTIVITY_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}\.json(\.\d+)?$/;

const STATES = new Set(['working', 'waiting']);

// Copied from lib/sessions.js (PRUNE_AFTER_MS). Files older than this are skipped and deleted.
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

// A crash sends no event, so "working" with no update for this long is
// treated as unknown. "waiting" is the state a session rests in and never goes stale,
// unless subagents above 0 make resolveActivity report it as "working".
const STALE_AFTER_MS = 10 * 60 * 1000;

// Copied from lib/sessions.js (expandHome).
function expandHome(p) {
  return p.replace(/^~/, os.homedir());
}

// Same precedence as getSessionsDir in lib/sessions.js, without a LIVE_SESSIONS_DIR-style override.
function getActivityDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), 'cc-dashboard', 'activity');
  return path.join(os.homedir(), '.claude', 'cc-dashboard', 'activity');
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// The file's content as { sessionId, state, since, tool, subagents, updatedAt }, or
// null when it is not in the shape the mod writes. A malformed tool becomes null, and
// a bad subagent count becomes 0: the state is still worth showing.
function parseActivity(a) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return null;
  if (typeof a.sessionId !== 'string' || !SESSION_ID_PATTERN.test(a.sessionId)) return null;
  if (!STATES.has(a.state) || !isTime(a.since) || !isTime(a.updatedAt)) return null;
  const t = a.tool;
  const tool = typeof t?.name === 'string' && isTime(t.startedAt)
    ? { name: t.name, detail: typeof t.detail === 'string' ? t.detail : '', startedAt: t.startedAt }
    : null;
  const subagents = Number.isInteger(a.subagents) && a.subagents >= 0 ? a.subagents : 0;
  return { sessionId: a.sessionId, state: a.state, since: a.since, tool, subagents, updatedAt: a.updatedAt };
}

// Every activity file updated in the last 24h, by session id. Files whose mtime is
// older than PRUNE_AFTER_MS are deleted. A file caught mid-write, or in another
// shape, is skipped.
function readActivity(dir = getActivityDir(), now = Date.now()) {
  const map = new Map();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!ACTIVITY_NAME_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) {
        fs.unlinkSync(file);
        continue;
      }
    } catch {
      continue; // gone already
    }
    if (!name.endsWith('.json')) continue;
    let a;
    try {
      a = parseActivity(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      continue;
    }
    if (a && now - a.updatedAt <= PRUNE_AFTER_MS) map.set(a.sessionId, a);
  }
  return map;
}

// What the dashboard shows for a session: its state, when that began, the running
// tool and the subagent count. Null when there is no activity or it is stale.
// A "waiting" file with subagents above 0 is reported as "working": the main loop's
// turn ended while an async subagent still runs. That "working" goes stale like any
// other. A subagent that is killed or fails sends no turn.complete, so its count can
// stay in the file. Each subagent tool call rewrites the file, so a running subagent
// keeps updatedAt fresh.
function resolveActivity(activity, now) {
  if (!activity) return null;
  const state = activity.state === 'waiting' && activity.subagents > 0 ? 'working' : activity.state;
  if (state !== 'waiting' && now - activity.updatedAt > STALE_AFTER_MS) return null;
  return { state, since: activity.since, tool: activity.tool, subagents: activity.subagents };
}

module.exports = { getActivityDir, readActivity, resolveActivity, STALE_AFTER_MS };
