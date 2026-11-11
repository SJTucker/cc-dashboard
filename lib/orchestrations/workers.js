'use strict';

const { stepsOf: stepsOfLines, contextTokens, watchEvents, isTaskFile } = require('../transcript-index.js');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const ATTENTION = new Set(['STUCK', 'DRIFT', 'BUDGET']);
// Statuses a worker reaches once it has finished its own work.
const PAST_DONE = new Set(['done', 'review', 'passed', 'changes', 'merged']);
const KEPT_STEPS = 8;

// One watchEvents string as { type, text, line, at }. The type is its first word.
// watchEvents gives no line except in MSG events, so other events carry the
// transcript's line count at the poll that reported them. at is the time of the
// step that raised the event: found by path for DRIFT, by tool for STUCK and by
// line for MSG, else the last new step. steps are the steps new in this poll.
function toEvent(s, lineCount, steps, fallbackAt) {
  const type = s.split(' ', 1)[0];
  const msg = type === 'MSG' ? /line (\d+)/.exec(s) : null;
  const line = msg ? Number(msg[1]) : lineCount;
  let step = null;
  if (type === 'MSG') step = steps.find((x) => x.line === line);
  else if (type === 'DRIFT') step = steps.find((x) => EDIT_TOOLS.has(x.tool) && s.endsWith(`: ${x.text}`));
  else if (type === 'STUCK') step = steps.findLast((x) => x.kind === 'error' && s.startsWith(`STUCK ${x.tool ?? '?'} `));
  step ??= steps.at(-1);
  return { type, text: s, line, at: step?.time ?? fallbackAt };
}

// The step with its path text relative to the worker's worktree, when it starts with
// "<worktree>/". Other text is unchanged. edited and touched use the original paths.
function relativeStep(step, worktree) {
  const prefix = worktree ? `${worktree.replace(/\/+$/, '')}/` : null;
  if (!prefix || typeof step.text !== 'string' || !step.text.startsWith(prefix)) return step;
  return { ...step, text: step.text.slice(prefix.length) };
}

// The live state of one worker from its transcript. read is { lines, mtimeMs, version }
// from the lines cache, or null before the transcript exists. meta is the worker's
// .meta.json. Two things carry over between calls, and the caller keeps both:
//   seen  watchEvents's state plus the events so far (undefined on the first call). It
//         advances the DONE settling, so detail polls and list polls each keep their own.
//   memo  a pure cache of what the steps gave: the last KEPT_STEPS steps, the last tool
//         and step, the edited files and the context size, with the parse context that
//         lets the next call parse only the lines appended since. It advances nothing,
//         so one memo can serve every caller. ctx.names gains one entry per tool call and
//         is not bounded. The sweep in discover.js frees it with the worker's memo.
// Returns { state, seen, memo }.
//
// Steps are parsed only for lines after memo.count, and only when read.version differs
// from memo's. watchEvents gets the steps from seen.next on; when seen lags the memo,
// those are parsed from seen.next alone. A different lines array, or fewer lines than
// seen or memo covered, means the transcript started over, so that one is dropped and
// rebuilt from the first line. The stepsOf option replaces transcript-index's stepsOf,
// for tests.
function workerState(agent, read, meta, seen, { now, budget = 120000, quietMs = 300000, stepsOf = stepsOfLines, memo }) {
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
    touched: [],
    events: [],
    quiet: false,
    // The meta file's finished flag, and whether the last step is a coordinator message
    // (the flag can be left from before a resume). raw is 'done' as soon as the flag holds
    // with no coordinator message last, so status and canSteer agree. settled is true once
    // watchEvents has the worker's report (or the flag has held for a poll), because the
    // flag is set before the last lines reach the transcript. A reviewer's verdict waits
    // for it.
    metaFinished: meta?.finished === true,
    lastIsMsg: false,
    settled: false,
    report: null,
    lastActiveAt: null,
  };
  const finished = meta?.finished === true;
  if (read) {
    const lines = read.lines;
    if (seen && (seen.linesRef?.deref() !== lines || lines.length < seen.next - 1)) seen = undefined;
    if (memo && (memo.lines.deref() !== lines || lines.length < memo.count)) memo = undefined;
  }
  base.events = seen?.events ?? [];
  if (!read || read.lines.length === 0) return { state: { ...base, lastActiveAt: read ? new Date(read.mtimeMs).toISOString() : null, raw: finished ? 'done' : 'starting' }, seen, memo };

  const { lines, mtimeMs } = read;
  const need = seen?.next ?? 1;
  const ctx = memo?.ctx ?? {};
  let next = memo;
  let appended = [];
  if (!memo || memo.version !== read.version) {
    const from = (memo?.count ?? 0) + 1;
    appended = stepsOf(lines, from, lines.length, ctx);
    const tools = appended.filter((x) => x.kind === 'tool');
    const edited = new Set(memo?.edited);
    for (const x of tools) if (EDIT_TOOLS.has(x.tool) && x.text) edited.add(x.text);
    next = {
      lines: memo?.lines ?? new WeakRef(lines),
      version: read.version,
      count: lines.length,
      ctx,
      recent: [...(memo?.recent ?? []), ...appended].slice(-KEPT_STEPS),
      tool: tools.at(-1) ?? memo?.tool ?? null,
      last: appended.at(-1) ?? memo?.last ?? null,
      edited,
      contextTokens: contextTokens(lines),
    };
  }
  // The steps new to seen: from the memo's own new steps when seen is level with it,
  // else parsed from seen.next with the memo's parse context. Its names Map is shared,
  // which is safe because tool_use ids are unique.
  const memoCount = memo?.count ?? 0;
  const fresh = need > memoCount ? appended.filter((x) => x.line >= need) : need > lines.length ? [] : stepsOf(lines, need, lines.length, { kind: ctx.kind, names: ctx.names });
  const r = watchEvents(lines, seen ?? null, { files: agent.files ?? null, budget, finished, steps: fresh });
  const fallbackAt = new Date(mtimeMs).toISOString();
  const events = [...base.events, ...r.events.map((e) => toEvent(e, lines.length, fresh, fallbackAt))];
  const quiet = now - mtimeMs > quietMs;
  const lastIsMsg = next.last?.kind === 'msg';
  const done = r.done || (finished && !lastIsMsg);
  let raw = 'working';
  if (done) raw = 'done';
  else if (events.some((e) => ATTENTION.has(e.type))) raw = 'stuck';
  else if (quiet) raw = 'quiet';
  const edited = [...next.edited];
  const state = {
    ...base,
    contextTokens: next.contextTokens,
    steps: next.recent.map((x) => relativeStep(x, agent.worktree)),
    current: next.tool,
    edited,
    touched: edited.filter((f) => isTaskFile(f, agent.files ?? [])),
    events,
    quiet,
    lastIsMsg,
    settled: r.done,
    raw,
    report: r.done ? (r.seen.report ?? (r.seen.lastText || null)) : null,
    lastActiveAt: next.last?.time ?? new Date(mtimeMs).toISOString(),
  };
  return { state, seen: { ...r.seen, events, linesRef: new WeakRef(lines) }, memo: next };
}

// Whether ISO time a is earlier than ISO time b. A missing time is never earlier.
function startedBefore(a, b) {
  if (!a || !b) return false;
  return Date.parse(a) < Date.parse(b);
}

// The review of one worker: the latest reviewer for its task, or null.
function reviewOf(worker, reviewers) {
  if (worker.task == null) return null;
  // A reviewer started before this worker belongs to an earlier run of the task.
  const mine = reviewers.filter((r) => r.task != null && String(r.task) === String(worker.task) && !startedBefore(r.startedAt, worker.startedAt));
  if (!mine.length) return null;
  const latest = mine.reduce((a, b) => ((b.startedAt ?? '') >= (a.startedAt ?? '') ? b : a));
  // A reviewer's verdict is read only once it is settled. The meta flag can be set before
  // the handback line is written.
  if (latest.raw !== 'done' || !latest.settled) return { status: 'running', startedAt: latest.startedAt };
  const passed = /^pass/i.test((latest.report ?? '').trim());
  return { status: passed ? 'passed' : 'changes', startedAt: latest.startedAt };
}

// Whether an attention event still holds. With no steer to the worker it does. A
// latest attention event newer than the latest steer holds. An older one holds
// until a worker step is timestamped after that steer. ISO timestamps compare as
// strings.
function isStuck(w, steers) {
  const attention = w.events.filter((e) => ATTENTION.has(e.type));
  if (!attention.length) return false;
  const mine = steers.filter((s) => s.to === w.agentId).map((s) => s.at);
  if (!mine.length) return true;
  const steer = mine.reduce((a, b) => (b > a ? b : a));
  const eventAt = attention.reduce((a, e) => ((e.at ?? '') > a ? e.at : a), '');
  if (eventAt > steer) return true;
  return !(w.lastActiveAt && w.lastActiveAt > steer);
}

// Adds status, review and steerCount to each worker, following the spec's "Worker status" order.
function resolveStatuses(workers, reviewers, merges, steers) {
  return workers.map((w) => {
    const review = reviewOf(w, reviewers);
    let status;
    if (merges.some((m) => w.task != null && m.task != null && String(m.task) === String(w.task) && !startedBefore(m.at, w.startedAt))) status = 'merged';
    else if (review?.status === 'running') status = 'review';
    else if (review) status = review.status;
    else if (w.raw === 'done') status = 'done';
    else if (w.raw === 'stuck' && isStuck(w, steers)) status = 'stuck';
    else if (w.raw === 'stuck') status = w.quiet ? 'quiet' : 'working';
    else status = w.raw;
    return { ...w, status, review, steerCount: steers.filter((s) => s.to === w.agentId).length };
  });
}

// Workers sorted by start time, those with no startedAt last. A worker with no startedAt
// never opens a wave: its start is unknown, so it joins the current one. A worker opens
// a new wave when every earlier worker is done or past it and had finished before this
// worker started. The second check keeps workers launched together in one wave after one
// of them finishes early.
function groupWaves(workers) {
  const sorted = [...workers].sort((a, b) => Number(!a.startedAt) - Number(!b.startedAt) || (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const waves = [];
  sorted.forEach((w, i) => {
    if (i === 0 || (w.startedAt && sorted.slice(0, i).every((e) => PAST_DONE.has(e.status) && e.lastActiveAt != null && e.lastActiveAt <= w.startedAt))) waves.push({ n: waves.length + 1, startedAt: w.startedAt, workers: [] });
    waves.at(-1).workers.push(w);
  });
  return waves;
}

module.exports = { workerState, resolveStatuses, groupWaves };
