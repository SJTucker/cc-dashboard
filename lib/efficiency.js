'use strict';

const { localDateStr } = require('./dates');
const { median, percentile } = require('../public/stats');

// Statistics for the setup changes panels. Pure functions over the compact records
// scanUsage() returns under `efficiency`, so every number on those panels can be
// tested without a fixture tree. See the README's "Setup changes" section for why
// these two metrics: they were the only ones in the spike stable enough to show a
// setup change without depending on the task.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function groupBySession(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.sessionId)) groups.set(item.sessionId, []);
    groups.get(item.sessionId).push(item);
  }
  for (const list of groups.values()) list.sort((a, b) => a.t - b.t);
  return groups;
}

function mainThreads(calls) {
  return groupBySession(calls.filter((c) => c.main));
}

// The first call of a session carries the fixed part of the context - system
// prompt, tool definitions, CLAUDE.md, skill list, SessionStart hook output - plus
// the first prompt. The task barely moves it; a plugin install does.
function sessionStarts(calls) {
  const starts = [];
  for (const list of mainThreads(calls).values()) {
    starts.push({ t: list[0].t, model: list[0].model, context: list[0].context });
  }
  return starts.sort((a, b) => a.t - b.t);
}

// What a Bash result added to the context: the next call's context minus the
// previous call's context and the output that call produced. Only after a response
// whose tool calls were all Bash - a parallel Read would add its file to the
// delta. A negative delta means the context shrank (compaction, /clear).
function bashDeltas(calls) {
  const deltas = [];
  for (const list of mainThreads(calls).values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      if (!prev.tools.length || !prev.tools.every((name) => name === 'Bash')) continue;
      const delta = list[i].context - prev.context - prev.output;
      if (delta >= 0) deltas.push({ t: list[i].t, delta });
    }
  }
  return deltas.sort((a, b) => a.t - b.t);
}

// Sum cost and count of calls in a time window, advancing the cursor.
function sumCallsInWindow(sessionCalls, j, start, end) {
  while (j < sessionCalls.length && sessionCalls[j].t < start) j++;
  let cost = 0;
  let n = 0;
  while (j < sessionCalls.length && sessionCalls[j].t < end) {
    cost += sessionCalls[j].cost;
    n += 1;
    j++;
  }
  return { cost, n, next: j };
}

// Every call in the session - subagents included, since they carry the parent's
// sessionId - from a typed prompt up to the next one. A prompt that got no call
// was interrupted before the model answered, and its cost of zero would pull the
// median down.
function promptStats(prompts, calls) {
  const callsBySession = groupBySession(calls);
  const out = [];
  for (const [sessionId, list] of groupBySession(prompts)) {
    const sessionCalls = callsBySession.get(sessionId) || [];
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      const start = list[i].t;
      const end = i + 1 < list.length ? list[i + 1].t : Infinity;
      const { cost, n, next } = sumCallsInWindow(sessionCalls, j, start, end);
      j = next;
      if (n > 0) out.push({ t: start, cost, calls: n });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// The before/after numbers for records already cut to one span: a 7-day window
// (windowStats) or one day (dailySeries). Both go through here, so a daily bar
// and a 7-day value cannot be computed two ways.
function stats({ starts, deltas, prompts, calls }) {
  const d = deltas.map((x) => x.delta);
  let context = 0;
  let cacheRead = 0;
  for (const c of calls) {
    context += c.context;
    cacheRead += c.cacheRead;
  }
  return {
    sessions: starts.length,
    sessionStart: median(starts.map((x) => x.context)),
    bashN: d.length,
    bashMedian: median(d),
    bashP90: percentile(d, 90),
    prompts: prompts.length,
    costPerPrompt: median(prompts.map((x) => x.cost)),
    callsPerPrompt: median(prompts.map((x) => x.calls)),
    callN: calls.length,
    cacheHit: context > 0 ? cacheRead / context : null,
  };
}

function windowStats({ starts, deltas, prompts, calls }, from, to) {
  const inWindow = (x) => x.t >= from && x.t < to;
  return stats({
    starts: starts.filter(inWindow),
    deltas: deltas.filter(inWindow),
    prompts: prompts.filter(inWindow),
    calls: calls.filter(inWindow),
  });
}

// Each daily series and the stats() count its n comes from. The keys are the
// before/after table's rows that come from the transcripts.
const DAILY_N = {
  sessionStart: 'sessions',
  bashMedian: 'bashN',
  bashP90: 'bashN',
  costPerPrompt: 'prompts',
  callsPerPrompt: 'prompts',
  cacheHit: 'callN',
};

// One series per table row: stats() over each local day's records. A day with no
// value for a row (no prompts, say) is left out of that row's series rather than
// drawn as a zero.
function dailySeries(data) {
  const days = new Map();
  for (const list of ['starts', 'deltas', 'prompts', 'calls']) {
    for (const x of data[list]) {
      const day = localDateStr(new Date(x.t));
      if (!days.has(day)) days.set(day, { starts: [], deltas: [], prompts: [], calls: [] });
      days.get(day)[list].push(x);
    }
  }
  const series = Object.fromEntries(Object.keys(DAILY_N).map((key) => [key, []]));
  for (const date of [...days.keys()].sort()) {
    const s = stats(days.get(date));
    for (const [key, n] of Object.entries(DAILY_N)) {
      if (s[key] != null) series[key].push({ date, n: s[n], value: s[key] });
    }
  }
  return series;
}

function windowRanges(markers) {
  return markers.flatMap((m) => [[m.t - WEEK_MS, m.t], [m.t, m.t + WEEK_MS]]);
}

// rtkWindows is readRtkWindows(windowRanges(markers)): two entries per marker,
// before then after, or null when rtk is unavailable.
function buildReport({ calls, prompts }, markers, rtkWindows, changesFile) {
  const data = { starts: sessionStarts(calls), deltas: bashDeltas(calls), prompts: promptStats(prompts, calls), calls };
  return {
    sessions: data.starts,
    daily: dailySeries(data),
    markers: markers.map((m, i) => ({
      ...m,
      before: { ...windowStats(data, m.t - WEEK_MS, m.t), rtk: rtkWindows ? rtkWindows[2 * i] : null },
      after: { ...windowStats(data, m.t, m.t + WEEK_MS), rtk: rtkWindows ? rtkWindows[2 * i + 1] : null },
    })),
    changesFile,
  };
}

module.exports = {
  WEEK_MS, median, percentile, sessionStarts, bashDeltas, promptStats, stats, windowStats, dailySeries, windowRanges, buildReport,
};
