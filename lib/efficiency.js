'use strict';

const { localDateStr } = require('./scan');

// Statistics for the setup changes panels. Pure functions over the compact records
// scanUsage() returns under `efficiency`, so every number on those panels can be
// tested without a fixture tree. See docs/superpowers/specs/2026-09-24-setup-changes-design.md
// for why these two metrics: they were the only ones in the spike stable enough to
// show a setup change without depending on the task.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank: always a value that occurred, which is what a reader expects of
// "90% of Bash results were under N".
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

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

function bashDaily(deltas) {
  const byDay = new Map();
  for (const { t, delta } of deltas) {
    const day = localDateStr(new Date(t));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(delta);
  }
  return [...byDay]
    .map(([date, values]) => ({ date, n: values.length, median: median(values) }))
    .sort((a, b) => a.date.localeCompare(b.date));
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

function windowStats({ starts, deltas, prompts, calls }, from, to) {
  const inWindow = (x) => x.t >= from && x.t < to;
  const s = starts.filter(inWindow);
  const d = deltas.filter(inWindow).map((x) => x.delta);
  const p = prompts.filter(inWindow);
  let context = 0;
  let cacheRead = 0;
  let callN = 0;
  for (const c of calls) {
    if (!inWindow(c)) continue;
    context += c.context;
    cacheRead += c.cacheRead;
    callN += 1;
  }
  return {
    sessions: s.length,
    sessionStart: median(s.map((x) => x.context)),
    bashN: d.length,
    bashMedian: median(d),
    bashP90: percentile(d, 90),
    prompts: p.length,
    costPerPrompt: median(p.map((x) => x.cost)),
    callsPerPrompt: median(p.map((x) => x.calls)),
    callN,
    cacheHit: context > 0 ? cacheRead / context : null,
  };
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
    bashDaily: bashDaily(data.deltas),
    markers: markers.map((m, i) => ({
      ...m,
      before: { ...windowStats(data, m.t - WEEK_MS, m.t), rtk: rtkWindows ? rtkWindows[2 * i] : null },
      after: { ...windowStats(data, m.t, m.t + WEEK_MS), rtk: rtkWindows ? rtkWindows[2 * i + 1] : null },
    })),
    changesFile,
  };
}

module.exports = {
  WEEK_MS, median, percentile, sessionStarts, bashDeltas, bashDaily, promptStats, windowStats, windowRanges, buildReport,
};
