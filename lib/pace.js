'use strict';

// Pace of the 5-hour rate-limit window, extrapolated from a short list of recent
// readings kept in rate-limits.json. mod/hooks/pace.ts holds a copy of computePace;
// both are tested against the same table of cases.

const fs = require('node:fs');
const path = require('node:path');
const { SESSION_ID_PATTERN } = require('./session-id');

const SPAN_MS = 15 * 60_000;
const RETAIN_MS = 20 * 60_000;
const MAX_ENTRIES = 60;
const MIN_GAP_MS = 3 * 60_000;
const MIN_RISE = 6;
const MARGIN_MS = 60 * 60_000;
// Claude Code's own "Nearing your plan limit" line covers the end of the window, so pace
// never reads fast once less than this is left.
const QUIET_MS = 45 * 60_000;
const FULL_RATE = 100;
const HOUR_MS = 3_600_000;

// Same rule as otherAccount in lib/limits.js: a missing id is unknown, not different.
function otherAccount(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== b;
}

// Adds one reading to the cache and returns { fiveHourRecent, fiveHourResetsAt }.
// Another account restarts the list, whatever its reset time. Otherwise a reading for
// an earlier window leaves the cache unchanged and a later window restarts the list.
function addReading(cache, reading) {
  const old = Array.isArray(cache?.fiveHourRecent) ? cache.fiveHourRecent : [];
  const oldResets = cache?.fiveHourResetsAt;
  const entry = { t: reading.t, percent: reading.percent, sessionId: reading.sessionId ?? null };
  const switched = otherAccount(cache?.accountUuid, reading.accountUuid);
  if (!switched && typeof oldResets === 'number' && reading.resetsAt < oldResets) {
    return { fiveHourRecent: old, fiveHourResetsAt: oldResets };
  }
  const restart = switched || (typeof oldResets === 'number' && reading.resetsAt > oldResets);
  const list = restart ? [] : old.slice();
  // Insert after the last entry that is not newer, so equal times keep arrival order.
  let i = list.length;
  while (i > 0 && list[i - 1].t > entry.t) i--;
  list.splice(i, 0, entry);
  const newest = list[list.length - 1].t;
  const kept = list.filter((e) => e.t >= newest - RETAIN_MS).slice(-MAX_ENTRIES);
  return { fiveHourRecent: kept, fiveHourResetsAt: reading.resetsAt };
}

// The session with the most entries in the span. A tie goes to the one with the
// newest entry. Entries without a session id do not count.
function busySession(span) {
  const stats = new Map();
  for (const e of span) {
    if (!e.sessionId) continue;
    const s = stats.get(e.sessionId) || { n: 0, last: -Infinity };
    s.n++;
    s.last = Math.max(s.last, e.t);
    stats.set(e.sessionId, s);
  }
  let best = null;
  let bestStat = null;
  for (const [id, s] of stats) {
    if (!bestStat || s.n > bestStat.n || (s.n === bestStat.n && s.last > bestStat.last)) {
      best = id;
      bestStat = s;
    }
  }
  return best;
}

// recent: entries oldest first. resetsAt: epoch seconds. now: ms.
// Returns null when there is nothing to report (no readings, window spent or reset).
function computePace(recent, resetsAt, now) {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  const current = recent[recent.length - 1].percent;
  const resetMs = resetsAt * 1000;
  if (current >= 100 || resetMs <= now) return null;

  const span = recent.filter((e) => e.t >= now - SPAN_MS && e.t <= now);
  const margin = Math.min(MARGIN_MS, (resetMs - now) / 2);
  const fastPerHour = (100 - current) / ((resetMs - margin - now) / HOUR_MS);
  const base = { percent: current, fastPerHour, runsOutAt: null, busySessionId: busySession(span) };
  if (span.length < 2) return { ...base, state: 'idle', ratePerHour: 0 };

  const oldest = span[0];
  const newest = span[span.length - 1];
  const rise = newest.percent - oldest.percent;
  const ms = now - oldest.t;
  if (rise <= 0 || ms <= 0) return { ...base, state: 'idle', ratePerHour: 0 };

  const ratePerHour = (rise * HOUR_MS) / ms;
  const runsOutAt = now + ((100 - current) / ratePerHour) * HOUR_MS;
  const fast =
    resetMs - now >= QUIET_MS && ratePerHour > fastPerHour && rise >= MIN_RISE && newest.t - oldest.t >= MIN_GAP_MS;
  return { ...base, state: fast ? 'fast' : 'steady', ratePerHour, runsOutAt };
}

// The pace for /api/limits, from rate-limits.json. resetsAt is in ms. busy names the
// session with the most readings and its project, read from sessions/<id>.json. A
// session id that is not a plain id gets no read, so it cannot point outside sessionsDir.
// Returns null when the file has no readings, the window is spent or reset, or claudeJson
// names another account than the file's.
function readPace({ rateLimits, sessionsDir, claudeJson, now = Date.now() }) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(rateLimits, 'utf8'));
  } catch {
    return null;
  }
  // The file's list belongs to the account that wrote it. After a /login switch it is
  // hidden until the new account's first reading restarts it.
  // lib/limits.js requires this file, so readAccountUuid is required here at call time.
  if (claudeJson && otherAccount(data?.accountUuid, require('./limits').readAccountUuid(claudeJson))) return null;
  const resetsAt = data?.fiveHourResetsAt;
  if (typeof resetsAt !== 'number') return null;
  const pace = computePace(data.fiveHourRecent, resetsAt, now);
  if (!pace) return null;
  let busy = null;
  const id = pace.busySessionId;
  if (id) {
    let project = null;
    if (SESSION_ID_PATTERN.test(id)) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'));
        if (typeof snap?.project === 'string' && snap.project) project = snap.project;
      } catch {
        // No snapshot: the session is named without a project.
      }
    }
    busy = { sessionId: id, project };
  }
  return { ...pace, resetsAt: resetsAt * 1000, busy };
}

module.exports = {
  readPace,
  addReading,
  computePace,
  SPAN_MS,
  RETAIN_MS,
  MAX_ENTRIES,
  MIN_GAP_MS,
  MIN_RISE,
  MARGIN_MS,
  QUIET_MS,
  FULL_RATE,
};
