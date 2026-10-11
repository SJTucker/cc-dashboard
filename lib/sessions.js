'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./files');
const { resolveActivity } = require('./activity');
const { windowStart } = require('./dates');
const { rebuildUsd } = require('./cache');
const { TTL_5M_MS, TTL_1H_MS, nextTtl } = require('./extract');
const { SESSION_ID_PATTERN, SESSION_FILE_PATTERN, PRUNE_AFTER_MS } = require('./session-id');

// Live sessions for the Today range. Claude Code sends its statusline command a
// cost block per session after every response, and bin/record-statusline hands
// it to recordSession below, which keeps one small snapshot file per session.
// The transcripts cannot supply these figures live: Claude Code writes its
// cost-state line only when a session ends or is cleared.

function getSessionsDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'sessions');
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
    if (!SESSION_FILE_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(file);
    } catch {
      // Another session pruned it first, or it is not ours to remove.
    }
  }
}

// Writes a snapshot. Returns false when the write failed. writeFileAtomic has
// already removed its tmp file by then.
function writeAtomic(file, text) {
  try {
    writeFileAtomic(file, text);
    return true;
  } catch {
    return false;
  }
}

// True when `existing` was written from a later render than `snapshot`.
function isNewer(existing, snapshot) {
  if (typeof existing?.lastActiveAt !== 'number') return false;
  if (existing.lastActiveAt !== snapshot.lastActiveAt) return existing.lastActiveAt > snapshot.lastActiveAt;
  return typeof existing.durationMs === 'number' && existing.durationMs > snapshot.durationMs;
}

// input is the parsed JSON a Claude Code statusLine command receives on stdin.
// Writes <dir>/<session_id>.json when input has a safe session id and a cost
// block. The statusline hook runs in the background, so two renders of one
// session can finish out of order. lastActiveAt is the transcript's mtime, which
// only grows, so a snapshot with an older lastActiveAt than the file on disk is
// skipped. total_duration_ms only breaks a tie between two renders after the same
// transcript write. On Claude Code 2.1.295 (checked 2026-10-09) a --resume keeps
// the duration growing, so ordering by lastActiveAt does not depend on it.
// Never throws: the statusline must render whatever happens here.
function recordSession(input, dir, now = Date.now()) {
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
    // The mod's id for the claude process that recorded this measure (statuslineInput
    // in mod/hooks/register.ts). Every session one process records shares it, so the
    // Today table can group the sessions a /clear split apart. An input without a
    // launch_id gets no launchId.
    if (typeof input.launch_id === 'string' && SESSION_ID_PATTERN.test(input.launch_id)) {
      snapshot.launchId = input.launch_id;
    }

    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // No snapshot yet, or one caught mid-write.
    }
    if (isNewer(existing, snapshot)) return;

    // A write without a valid launch_id keeps the one an earlier write stored, so
    // the session stays in its launch group.
    if (snapshot.launchId === undefined && typeof existing?.launchId === 'string') {
      snapshot.launchId = existing.launchId;
    }

    // recordSession copies endedAt and endReason from recordSessionEnd into each rewrite.
    if (typeof existing?.endedAt === 'number') {
      snapshot.endedAt = existing.endedAt;
      snapshot.endReason = existing.endReason;
    }

    if (!writeAtomic(file, JSON.stringify(snapshot))) return;
    prune(dir, now);
  } catch {
    // An unwritable directory or an unexpected input shape: record nothing.
  }
}

// input is the parsed JSON the mod's session.end hook sends to bin/record-session-end
// on stdin. Marks that session's snapshot as ended: endedAt is when the hook ran,
// and endReason is why the session ended, for example clear, resume, logout or
// prompt_input_exit. A session with no snapshot has no row in the panel, so nothing
// is written for it.
function recordSessionEnd(input, dir, now = Date.now()) {
  try {
    const id = input?.session_id;
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return;
    if (typeof input.reason !== 'string') return;
    const file = path.join(dir, `${id}.json`);
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return; // no snapshot, or one caught mid-write
    }
    if (typeof existing !== 'object' || existing === null) return;

    writeAtomic(file, JSON.stringify({ ...existing, endedAt: now, endReason: input.reason }));
  } catch {
    // An unexpected input shape: record nothing.
  }
}

// A session counts as live when it wrote to its transcript this recently. Older
// sessions from today stay listed, with their last-active time.
const LIVE_WINDOW_MS = 10 * 60 * 1000;

const NUMBER_FIELDS = ['lastActiveAt', 'costUsd', 'durationMs', 'apiDurationMs', 'linesAdded', 'linesRemoved'];

// Claude Code's SessionEnd reasons are lowercase words joined by underscores.
const END_REASON_PATTERN = /^[a-z_]{1,32}$/;

// A statusline render that started before a session ended can finish just after
// bin/record-session-end ran, with a transcript mtime a moment after endedAt. Last
// activity up to this long after the end still counts as part of the ended session.
const END_GRACE_MS = 5000;

// Today's snapshots, newest first. "Today" starts at local midnight, the same
// boundary as the Today scan. A file caught mid-write, or in a shape this code
// did not write, is skipped.
function readSessions(dir, now = Date.now()) {
  const midnight = windowStart('today', now);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof s?.sessionId !== 'string' || !NUMBER_FIELDS.every((k) => typeof s[k] === 'number')) continue;
    if (s.lastActiveAt < midnight) continue;
    if (typeof s.endedAt !== 'number') delete s.endedAt;
    if (typeof s.endReason !== 'string' || !END_REASON_PATTERN.test(s.endReason)) delete s.endReason;
    sessions.push(s);
  }
  return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// Today's activity of one session as [[start, end], ...] in ms, from the times of
// its calls. A gap longer than LIVE_WINDOW_MS starts a new span, so a session that
// sat idle for an hour shows as two bars. A span with one call has start === end.
function toSpans(times) {
  const spans = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last && t - last[1] <= LIVE_WINDOW_MS) last[1] = t;
    else spans.push([t, t]);
  }
  return spans;
}

// Today's prompt-cache rebuilds per session, oldest first: the calls that
// markRebuilds in lib/extract.js tagged and aggregate in lib/aggregate.js priced.
// main is false for a subagent's rebuild.
function rebuildsBySession(calls) {
  const out = new Map();
  for (const c of calls) {
    if (!c.rebuild || typeof c.t !== 'number') continue;
    if (!out.has(c.sessionId)) out.set(c.sessionId, []);
    out.get(c.sessionId).push({ t: c.t, main: c.main !== false, ...c.rebuild });
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return out;
}

// The prompt cache of a session waiting on the user: its TTL, when it expires, and
// what the next reply pays to write the context back into the cache over reading
// it. Built from the main thread's calls only, because a subagent has its own
// cache. Null when the session has no main call. minutesLeft is negative once the
// cache has expired. expiresAt counts from the newest call's transcript timestamp,
// which can be later than the request start the API counts from.
function cacheOf(calls, now) {
  const main = calls.filter((c) => c.main === true && typeof c.t === 'number').sort((a, b) => a.t - b.t);
  if (!main.length) return null;
  let ttl = TTL_5M_MS;
  for (const c of main) {
    ttl = nextTtl({ cache_creation: { ephemeral_5m_input_tokens: c.write5m || 0, ephemeral_1h_input_tokens: c.write1h || 0 } }, ttl);
  }
  const newest = main[main.length - 1];
  const expiresAt = newest.t + ttl;
  const ttlName = ttl === TTL_1H_MS ? '1h' : '5m';
  return {
    ttl: ttlName,
    expiresAt,
    minutesLeft: Math.floor((expiresAt - now) / 60000),
    rebuildUsd: rebuildUsd(newest.context, ttlName, newest.model, now),
  };
}

// Joins each snapshot with its tokens and cost from the Today scan's per-call
// records. The cost block (costUsd) is cumulative for the whole session, but
// calls and linesBySession cover today only, so a session that began yesterday
// shows fewer tokens, less cost today (costTodayUsd) and fewer lines than over
// its whole life. Wall durations overlap across concurrent sessions, so the
// total leaves them out. spans, prompts and rebuilds cover today only, like tokens.
// branchesBySession, branchBySession and firstPromptBySession come from the same
// call to aggregate in lib/aggregate.js.
function buildLiveSessions(snapshots, calls, now = Date.now(), linesBySession = {}, titleBySession = {}, prompts = [], activityBySession = new Map(), { branchesBySession = {}, branchBySession = {}, firstPromptBySession = {} } = {}) {
  const tokensBySession = new Map();
  const costTodayBySession = new Map();
  const lastCallBySession = new Map();
  const timesBySession = new Map();
  for (const c of calls) {
    tokensBySession.set(c.sessionId, (tokensBySession.get(c.sessionId) || 0) + c.context + c.output);
    costTodayBySession.set(c.sessionId, (costTodayBySession.get(c.sessionId) || 0) + c.cost);
    if (typeof c.t === 'number') {
      if (c.t > (lastCallBySession.get(c.sessionId) || 0)) lastCallBySession.set(c.sessionId, c.t);
      if (!timesBySession.has(c.sessionId)) timesBySession.set(c.sessionId, []);
      timesBySession.get(c.sessionId).push(c.t);
    }
  }
  const rebuilds = rebuildsBySession(calls);
  const promptsBySession = new Map();
  for (const p of prompts) promptsBySession.set(p.sessionId, (promptsBySession.get(p.sessionId) || 0) + 1);
  const total = { costUsd: 0, costTodayUsd: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 };
  const sessions = snapshots.map((s) => {
    // A subagent writes to its own transcript under <session>/subagents/, so the
    // main transcript's mtime (s.lastActiveAt) stays the same while a subagent runs.
    // The subagent's calls carry the parent's sessionId, so the newest call counts
    // as activity too.
    const lastActiveAt = Math.max(s.lastActiveAt, lastCallBySession.get(s.sessionId) || 0);
    const tokens = tokensBySession.get(s.sessionId) || 0;
    const costTodayUsd = costTodayBySession.get(s.sessionId) || 0;
    // From today's Edit and Write results (collectEdits in lib/extract.js, summed in aggregate in lib/aggregate.js). The snapshot's own
    // linesAdded and linesRemoved are 0 when the recorder mod wrote it.
    const lines = linesBySession[s.sessionId] || { added: 0, removed: 0 };
    // Ended when bin/record-session-end marked the session no earlier than
    // END_GRACE_MS before its last activity. A resumed session keeps its id, and its
    // next response moves lastActiveAt further past endedAt, so it counts as open again.
    const ended = typeof s.endedAt === 'number' && s.endedAt >= lastActiveAt - END_GRACE_MS
      ? s.endReason || 'other'
      : null;
    const branches = branchesBySession[s.sessionId] || [];
    const aiTitle = titleBySession[s.sessionId] ?? null;
    const promptTitle = aiTitle ? null : firstPromptBySession[s.sessionId] ?? null;
    total.costUsd += s.costUsd;
    total.costTodayUsd += costTodayUsd;
    total.linesAdded += lines.added;
    total.linesRemoved += lines.removed;
    total.tokens += tokens;
    const activity = ended === null ? resolveActivity(activityBySession.get(s.sessionId), now) : null;
    const cache = activity?.state === 'waiting' ? cacheOf(calls.filter((c) => c.sessionId === s.sessionId), now) : null;
    return {
      project: s.project,
      // The claude process that last recorded the session (recordSession). Null
      // without the mod.
      launchId: s.launchId ?? null,
      // Claude Code's own title from the last ai-title line (extractFile in lib/extract.js, merged by mergeSessions in lib/aggregate.js), else the
      // first prompt typed in the session. titleSource says which, so the page can
      // show a prompt differently. Both null for a session with neither.
      title: aiTitle ?? promptTitle,
      titleSource: aiTitle ? 'ai' : promptTitle ? 'prompt' : null,
      // branch is the branch of the session's newest transcript line, and branches is
      // every branch it used, in first-seen order.
      branch: branchBySession[s.sessionId] ?? null,
      branches,
      costUsd: s.costUsd,
      costTodayUsd,
      durationMs: s.durationMs,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      tokens,
      lastActiveAt,
      // Today's activity as [start, end] ms pairs (toSpans), and the typed prompts
      // today (efficiency.prompts).
      spans: toSpans(timesBySession.get(s.sessionId) || []),
      prompts: promptsBySession.get(s.sessionId) || 0,
      // Today's prompt-cache rebuilds (rebuildsBySession), for the Session timeline.
      rebuilds: rebuilds.get(s.sessionId) || [],
      ended,
      live: ended === null && now - lastActiveAt <= LIVE_WINDOW_MS,
      // The mod's live state (lib/activity.js). Null without the mod, for an ended
      // session, and for working that went stale. A waiting session keeps its state
      // however long it has waited, because it waits on the user.
      activity,
      // Only a session waiting on the user has a cache countdown (cacheOf).
      ...(cache ? { cache } : {}),
    };
  });
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return { sessions, total };
}

module.exports = {
  LIVE_WINDOW_MS, END_GRACE_MS, getSessionsDir, recordSession, recordSessionEnd, readSessions, buildLiveSessions,
};
