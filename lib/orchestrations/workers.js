'use strict';

const { stepsOf, contextTokens, watchEvents } = require('../transcript-index.js');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const ATTENTION = new Set(['STUCK', 'DRIFT', 'BUDGET']);
// Statuses a worker reaches once it has finished its own work.
const PAST_DONE = new Set(['done', 'review', 'passed', 'changes', 'merged']);
const KEPT_STEPS = 8;

// One watchEvents string as { type, text, line }. The type is its first word.
// watchEvents gives no line except in MSG events, so other events carry the
// transcript's line count at the poll that reported them.
function toEvent(s, lineCount) {
  const type = s.split(' ', 1)[0];
  const msg = type === 'MSG' ? /line (\d+)/.exec(s) : null;
  return { type, text: s, line: msg ? Number(msg[1]) : lineCount };
}

// The live state of one worker from its transcript. read is { lines, mtimeMs } or
// null before the transcript exists. meta is the worker's .meta.json. seen is the
// state returned by the previous call for this worker (undefined on the first); the
// caller keeps it between polls. It is watchEvents's state plus the events so far.
function workerState(agent, read, meta, seen, { now, budget = 120000, quietMs = 300000 }) {
  const base = {
    agentId: agent.agentId,
    task: agent.task,
    title: agent.title,
    files: agent.files,
    doneWhen: agent.doneWhen,
    startedAt: agent.startedAt,
    contextTokens: null,
    steps: [],
    current: null,
    edited: [],
    events: seen?.events ?? [],
    quiet: false,
    report: null,
    lastActiveAt: null,
  };
  if (!read) return { state: { ...base, raw: 'starting' }, seen };

  const { lines, mtimeMs } = read;
  const r = watchEvents(lines, seen ?? null, { files: agent.files ?? null, budget, finished: meta?.finished === true });
  const events = [...base.events, ...r.events.map((e) => toEvent(e, lines.length))];
  const all = stepsOf(lines, 1, lines.length);
  const tools = all.filter((s) => s.kind === 'tool');
  const edited = [...new Set(tools.filter((s) => EDIT_TOOLS.has(s.tool) && s.text).map((s) => s.text))];
  const quiet = now - mtimeMs > quietMs;
  let raw = 'working';
  if (r.done) raw = 'done';
  else if (events.some((e) => ATTENTION.has(e.type))) raw = 'stuck';
  else if (quiet) raw = 'quiet';
  const state = {
    ...base,
    contextTokens: contextTokens(lines),
    steps: all.slice(-KEPT_STEPS),
    current: tools.at(-1) ?? null,
    edited,
    events,
    quiet,
    raw,
    report: r.done ? (r.seen.report ?? (r.seen.lastText || null)) : null,
    lastActiveAt: all.at(-1)?.time ?? new Date(mtimeMs).toISOString(),
  };
  return { state, seen: { ...r.seen, events } };
}

// The review of one worker: the latest reviewer for its task, or null.
function reviewOf(worker, reviewers) {
  const mine = reviewers.filter((r) => String(r.task) === String(worker.task));
  if (!mine.length) return null;
  const latest = mine.reduce((a, b) => ((b.startedAt ?? '') >= (a.startedAt ?? '') ? b : a));
  if (latest.raw !== 'done') return { status: 'running', startedAt: latest.startedAt };
  const passed = /^pass/i.test((latest.report ?? '').trim());
  return { status: passed ? 'passed' : 'changes', startedAt: latest.startedAt };
}

// Whether the latest attention event still holds: no steer to the worker, or no
// worker step after the latest steer. ISO timestamps compare as strings.
function isStuck(w, steers) {
  if (!w.events.some((e) => ATTENTION.has(e.type))) return false;
  const mine = steers.filter((s) => s.to === w.agentId).map((s) => s.at);
  if (!mine.length) return true;
  const latest = mine.reduce((a, b) => (b > a ? b : a));
  return !(w.lastActiveAt && w.lastActiveAt > latest);
}

// Adds status and review to each worker, following the spec's "Worker status" order.
function resolveStatuses(workers, reviewers, merges, steers) {
  return workers.map((w) => {
    const review = reviewOf(w, reviewers);
    let status;
    if (merges.some((m) => String(m.task) === String(w.task))) status = 'merged';
    else if (review?.status === 'running') status = 'review';
    else if (review) status = review.status;
    else if (w.raw === 'done') status = 'done';
    else if (w.raw === 'stuck' && isStuck(w, steers)) status = 'stuck';
    else if (w.raw === 'stuck') status = w.quiet ? 'quiet' : 'working';
    else status = w.raw;
    return { ...w, status, review };
  });
}

// Workers sorted by start time. A worker opens a new wave when every earlier worker
// is done or past it and had finished before this worker started. The second check
// keeps workers launched together in one wave after one of them finishes early.
function groupWaves(workers) {
  const sorted = [...workers].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const waves = [];
  sorted.forEach((w, i) => {
    if (i === 0 || sorted.slice(0, i).every((e) => PAST_DONE.has(e.status) && (e.lastActiveAt ?? '') <= w.startedAt)) waves.push({ n: waves.length + 1, startedAt: w.startedAt, workers: [] });
    waves.at(-1).workers.push(w);
  });
  return waves;
}

module.exports = { workerState, resolveStatuses, groupWaves };
