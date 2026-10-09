'use strict';

const fs = require('fs');
const path = require('path');
const { SESSION_ID_PATTERN, SESSION_FILE_PATTERN, PRUNE_AFTER_MS } = require('./session-id');

// Live state of each session, written by the Claude Code mod (mod/hooks/register.ts)
// to <config dir>/cc-dashboard/activity/<session id>.json each time the state
// changes. This module reads those files and prunes old ones: readActivity deletes
// files whose mtime is older than PRUNE_AFTER_MS.

const STATES = new Set(['working', 'waiting']);

// A crash sends no event, so "working" with no update for this long is treated as
// unknown. "waiting" waits on the user and never goes stale, because the user can
// take hours to come back.
const STALE_AFTER_MS = 10 * 60 * 1000;

function getActivityDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'activity');
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
function readActivity(dir, now = Date.now()) {
  const map = new Map();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!SESSION_FILE_PATTERN.test(name)) continue;
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
// tool and the subagent count. Null when there is no activity, or when a "working"
// file is stale.
// A "waiting" file with subagents above 0 is reported as "working": the main loop's
// turn ended while an async subagent still runs. Each subagent tool call rewrites the
// file, so a running subagent keeps updatedAt fresh. A subagent that is killed or
// fails sends no turn.complete, so its count can stay in the file. Once that file is
// stale, it is reported as "waiting" with no subagents, because the main loop still
// waits on the user.
function resolveActivity(activity, now) {
  if (!activity) return null;
  const stale = now - activity.updatedAt > STALE_AFTER_MS;
  if (activity.state === 'waiting' && activity.subagents > 0) {
    if (stale) return { state: 'waiting', since: activity.since, tool: null, subagents: 0 };
    return { state: 'working', since: activity.since, tool: activity.tool, subagents: activity.subagents };
  }
  if (activity.state === 'working' && stale) return null;
  return { state: activity.state, since: activity.since, tool: activity.tool, subagents: activity.subagents };
}

module.exports = { getActivityDir, readActivity, resolveActivity, STALE_AFTER_MS };
