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

// Writes text to file through a tmp file and a rename, so a reader never sees a
// half-written file. Returns false when the write failed, after removing the tmp file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    return false;
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

// input is the parsed JSON a Claude Code SessionEnd hook receives on stdin. Marks
// that session's snapshot as ended: endedAt is when the hook ran, and endReason is
// why the session ended, for example clear, resume, logout or prompt_input_exit. A
// session with no snapshot has no row in the panel, so nothing is written for it.
function recordSessionEnd(input, dir = getSessionsDir(), now = Date.now()) {
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
function readSessions(dir = getSessionsDir(), now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
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
    if (s.lastActiveAt < midnight.getTime()) continue;
    if (typeof s.endedAt !== 'number') delete s.endedAt;
    if (typeof s.endReason !== 'string' || !END_REASON_PATTERN.test(s.endReason)) delete s.endReason;
    sessions.push(s);
  }
  return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

// Joins each snapshot with its tokens and cost from the Today scan's per-call
// records. The cost block (costUsd) is cumulative for the whole session, but
// calls and linesBySession cover today only, so a session that began yesterday
// shows fewer tokens, less cost today (costTodayUsd) and fewer lines than over
// its whole life. Wall durations overlap across concurrent sessions, so the
// total leaves them out.
function buildLiveSessions(snapshots, calls, now = Date.now(), linesBySession = {}, titleBySession = {}) {
  const tokensBySession = new Map();
  const costTodayBySession = new Map();
  const lastCallBySession = new Map();
  for (const c of calls) {
    tokensBySession.set(c.sessionId, (tokensBySession.get(c.sessionId) || 0) + c.context + c.output);
    costTodayBySession.set(c.sessionId, (costTodayBySession.get(c.sessionId) || 0) + c.cost);
    if (typeof c.t === 'number' && c.t > (lastCallBySession.get(c.sessionId) || 0)) {
      lastCallBySession.set(c.sessionId, c.t);
    }
  }
  const total = { costUsd: 0, costTodayUsd: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 };
  const sessions = snapshots.map((s) => {
    // A subagent writes to its own transcript under <session>/subagents/, so the
    // main transcript's mtime (s.lastActiveAt) stays the same while a subagent runs.
    // The subagent's calls carry the parent's sessionId, so the newest call counts
    // as activity too.
    const lastActiveAt = Math.max(s.lastActiveAt, lastCallBySession.get(s.sessionId) || 0);
    const tokens = tokensBySession.get(s.sessionId) || 0;
    const costTodayUsd = costTodayBySession.get(s.sessionId) || 0;
    // From today's Edit and Write results (lib/scan.js). The snapshot's own
    // linesAdded and linesRemoved are 0 when the recorder mod wrote it.
    const lines = linesBySession[s.sessionId] || { added: 0, removed: 0 };
    // Ended when bin/record-session-end marked the session no earlier than
    // END_GRACE_MS before its last activity. A resumed session keeps its id, and its
    // next response moves lastActiveAt further past endedAt, so it counts as open again.
    const ended = typeof s.endedAt === 'number' && s.endedAt >= lastActiveAt - END_GRACE_MS
      ? s.endReason || 'other'
      : null;
    total.costUsd += s.costUsd;
    total.costTodayUsd += costTodayUsd;
    total.linesAdded += lines.added;
    total.linesRemoved += lines.removed;
    total.tokens += tokens;
    return {
      project: s.project,
      // Claude Code's own title from the last ai-title line (lib/scan.js). Null
      // for the sessions that never got one.
      title: titleBySession[s.sessionId] ?? null,
      costUsd: s.costUsd,
      costTodayUsd,
      durationMs: s.durationMs,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      tokens,
      lastActiveAt,
      ended,
      live: ended === null && now - lastActiveAt <= LIVE_WINDOW_MS,
    };
  });
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return { sessions, total };
}

module.exports = {
  SESSION_ID_PATTERN, LIVE_WINDOW_MS, END_GRACE_MS, getSessionsDir, recordSession, recordSessionEnd, readSessions, buildLiveSessions, writeAtomic,
};
