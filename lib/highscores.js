'use strict';

// The all-time record boards for the High scores tab, and today's live record
// values. public/highscores/boards.mjs ranks the entries and merges today in, in the
// browser and here, so both sides rank the same way.

const { BOARDS, rankEntries, localDate } = require('../public/highscores/boards.mjs');

// The local midnight that starts a 'YYYY-MM-DD' date, as epoch ms. It is the `at`
// that mergeToday gives today's day entries, so a tie goes to the earlier day.
function midnight(date) {
  return Date.parse(date + 'T00:00:00');
}

// The date after a 'YYYY-MM-DD' date, by calendar day so a daylight saving change
// cannot skip or repeat one.
function nextDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + 1).getTime());
}

// A session's or turn's title, in the order lib/turns.js uses: the handoff file's
// heading, then the summary title, then the first prompt. null when none exists.
function titleLookup(efficiency) {
  const { handoffTitleBySession = {}, titleBySession = {}, firstPromptBySession = {} } = efficiency;
  return (sessionId) => handoffTitleBySession[sessionId] ?? titleBySession[sessionId] ?? firstPromptBySession[sessionId] ?? null;
}

// The six per-day boards' entries from the daily buckets, the typed prompts and the
// calls, leaving out todayStr. Days with a score of 0 are dropped later by rankEntries.
function dayBoards(data, todayStr) {
  const { calls, prompts } = data.efficiency;
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { tokens: 0, cost: 0, prompts: 0, sessions: new Set(), linesAdded: 0, linesRemoved: 0 });
    return days.get(date);
  };
  for (const b of data.daily) {
    const d = day(b.date.slice(0, 10));
    d.tokens += b.input + b.output + b.cacheCreate + b.cacheRead;
    d.cost += b.cost;
    d.linesAdded += b.linesAdded;
    d.linesRemoved += b.linesRemoved;
  }
  for (const p of prompts) day(localDate(p.t)).prompts += 1;
  // A session that spans midnight is in the set of both days.
  for (const c of calls) day(localDate(c.t)).sessions.add(c.sessionId);
  const out = {};
  for (const key of ['tokens', 'cost', 'prompts', 'sessions', 'linesAdded', 'linesRemoved']) {
    const entries = [];
    for (const [date, d] of days) {
      if (date === todayStr) continue;
      entries.push({ id: date, date, at: midnight(date), score: key === 'sessions' ? d.sessions.size : d[key] });
    }
    out[key] = rankEntries(entries);
  }
  return out;
}

// The session board, and the carry map for sessions that have a call today. Each
// session's cost is the sum of all its calls, subagent calls included. A session
// with a call today is left out of the board and carried with its cost from before
// today, because the browser adds today's cost to it. Sessions with no cost before
// today are not carried.
function sessionBoard(calls, titleOf, todayStr) {
  const sessions = new Map();
  for (const c of calls) {
    let s = sessions.get(c.sessionId);
    if (!s) sessions.set(c.sessionId, (s = { cost: 0, before: 0, at: c.t, today: false }));
    s.cost += c.cost;
    s.at = Math.min(s.at, c.t);
    if (localDate(c.t) === todayStr) s.today = true;
    else s.before += c.cost;
  }
  const entries = [];
  const carry = {};
  for (const [id, s] of sessions) {
    if (s.today) {
      if (s.before > 0) carry[id] = { cost: s.before, at: s.at };
    } else {
      entries.push({ id, date: localDate(s.at), at: s.at, score: s.cost, title: titleOf(id) });
    }
  }
  return { board: rankEntries(entries), carry };
}

// The streak board and the run that ends yesterday. A run is consecutive local dates
// before todayStr with tokens above 0. Zero days from fillAxis break a run. The
// board entry's id and date are the run's first day.
function streaks(data, todayStr) {
  const active = new Set();
  for (const b of data.daily) {
    if (b.input + b.output + b.cacheCreate + b.cacheRead > 0 && b.date.slice(0, 10) < todayStr) active.add(b.date.slice(0, 10));
  }
  const runs = [];
  for (const date of [...active].sort()) {
    const last = runs[runs.length - 1];
    if (last && nextDate(last.end) === date) {
      last.end = date;
      last.days += 1;
    } else {
      runs.push({ start: date, end: date, days: 1 });
    }
  }
  const board = rankEntries(runs.map((r) => ({ id: r.start, date: r.start, end: r.end, at: midnight(r.start), score: r.days })));
  const yesterday = localDate(new Date(midnight(todayStr) - 12 * 3600 * 1000).getTime());
  return { board, currentRun: runs.find((r) => r.end === yesterday) ?? null };
}

// The payload of GET /api/highscores from the all-time scan: the ranked top 10 of
// all nine boards without today's entries, the date it was built for, the run that
// ends yesterday, and the cost before today of each session that has a call today.
function buildHighscores(data, todayStr) {
  const titleOf = titleLookup(data.efficiency);
  const { board: session, carry } = sessionBoard(data.efficiency.calls, titleOf, todayStr);
  const turn = rankEntries(data.efficiency.turns
    .filter((x) => localDate(x.t) !== todayStr)
    .map((x) => ({ id: x.sessionId + ':' + x.t, date: localDate(x.t), at: x.t, score: x.durationMs, title: titleOf(x.sessionId) })));
  const { board: streak, currentRun } = streaks(data, todayStr);
  const boards = { ...dayBoards(data, todayStr), session, turn, streak };
  // Keep the key order of BOARDS.
  const ordered = Object.fromEntries(BOARDS.map(({ key }) => [key, boards[key]]));
  return { date: todayStr, boards: ordered, currentRun, carry };
}

// Today's record values from the Today scan (hour buckets): totals, the typed prompt
// count, the number of distinct sessions, each session's cost today with its first
// call today, and today's 10 longest turns. The browser merges these into the boards.
function todayRecords(data, todayStr) {
  const titleOf = titleLookup(data.efficiency);
  const live = { date: todayStr, tokens: 0, cost: 0, prompts: data.efficiency.prompts.length, sessions: 0, linesAdded: 0, linesRemoved: 0 };
  for (const b of data.daily) {
    live.tokens += b.input + b.output + b.cacheCreate + b.cacheRead;
    live.cost += b.cost;
    live.linesAdded += b.linesAdded;
    live.linesRemoved += b.linesRemoved;
  }
  const sessions = new Map();
  for (const c of data.efficiency.calls) {
    const s = sessions.get(c.sessionId);
    if (s) {
      s.cost += c.cost;
      s.at = Math.min(s.at, c.t);
    } else {
      sessions.set(c.sessionId, { sessionId: c.sessionId, cost: c.cost, at: c.t, title: titleOf(c.sessionId) });
    }
  }
  live.sessions = sessions.size;
  live.sessionCosts = [...sessions.values()];
  live.turns = [...data.efficiency.turns]
    .sort((a, b) => b.durationMs - a.durationMs || a.t - b.t)
    .slice(0, 10)
    .map((x) => ({ sessionId: x.sessionId, t: x.t, durationMs: x.durationMs, title: titleOf(x.sessionId) }));
  return live;
}

module.exports = { buildHighscores, todayRecords };
