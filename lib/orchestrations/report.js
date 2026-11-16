'use strict';

const { taskOfFile } = require('./events');
const { costForUsage } = require('../pricing');
const { taskLabel } = require('./feed');

// The per-task metrics of one orchestrate run, built from its event log (events.js),
// the agents' agent-usage steps and the files each agent read. buildReport is pure;
// bin/orch-report reads the files and calls it.

const ENDING = ['DONE', 'KILLED', 'FAILED'];

const ms = (e) => Date.parse(e.t);

function taskNumber(e) {
  if (Number.isInteger(e.task)) return e.task;
  return taskOfFile(e.file)?.task ?? null;
}

function emptyRow(task) {
  return { task, title: null, attempts: 0, reviewPass: 0, reviewFail: 0, steers: 0, denied: 0, watch: {}, slotWaitMs: null, wallMs: null, waitingMs: null };
}

function countInto(row, e) {
  if (e.kind === 'added' && e.queue === 'work') row.attempts++;
  else if (e.kind === 'review-pass') row.reviewPass++;
  else if (e.kind === 'review-fail') row.reviewFail++;
  else if (e.kind === 'steer') row.steers++;
  else if (e.kind === 'denied') row.denied++;
  else if (e.kind === 'watch' && e.name) row.watch[e.name] = (row.watch[e.name] ?? 0) + 1;
}

// Task 0, the fix for the final review's findings, is committed on the feature branch.
// The orchestrator logs no `ready` or `merged` for it. So a task with no `ready` starts
// at its first `added`, and a task with no `merged` ends at its last `review-pass`.
const startKind = (events) => (events.some((e) => e.kind === 'ready') ? 'ready' : 'added');

// From the last start event before the task's first claim of a work file, to that claim.
function slotWait(events, queueOf) {
  const claim = events.find((e) => e.kind === 'claimed' && queueOf.get(e.file) !== 'review');
  if (!claim) return null;
  const kind = startKind(events);
  const ready = events.filter((e) => e.kind === kind && ms(e) <= ms(claim)).pop();
  return ready ? ms(claim) - ms(ready) : null;
}

function wallTime(events) {
  const kind = startKind(events);
  const first = events.find((e) => e.kind === kind);
  const end = events.find((e) => e.kind === 'merged') ?? events.filter((e) => e.kind === 'review-pass').pop();
  return first && end ? ms(end) - ms(first) : null;
}

// The sum of each waiting-to-answered gap. A waiting with no answer runs to `end`.
function waitingTime(events, end) {
  let total = 0;
  let since = null;
  let seen = false;
  for (const e of events) {
    if (e.kind === 'waiting' && since === null) {
      since = ms(e);
      seen = true;
    } else if (e.kind === 'answered' && since !== null) {
      total += ms(e) - since;
      since = null;
    }
  }
  if (since !== null) total += end - since;
  return seen ? total : null;
}

// The title every titled `added` event of the task agrees on, else null.
function sharedTitle(list) {
  const titles = new Set(list.filter((e) => e.kind === 'added' && typeof e.title === 'string' && e.title !== '').map((e) => e.title));
  return titles.size === 1 ? [...titles][0] : null;
}

function taskRows(events, queueOf, end) {
  const byTask = new Map();
  for (const e of events) {
    const n = taskNumber(e);
    if (n === null) continue;
    if (!byTask.has(n)) byTask.set(n, []);
    byTask.get(n).push(e);
  }
  return [...byTask.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const list = byTask.get(n);
      const row = emptyRow(n);
      for (const e of list) countInto(row, e);
      row.title = sharedTitle(list);
      row.slotWaitMs = slotWait(list, queueOf);
      row.wallMs = wallTime(list);
      row.waitingMs = waitingTime(list, end);
      return row;
    });
}

function stepUsage(s) {
  return { input_tokens: s.input, cache_read_input_tokens: s.cacheRead, cache_creation_input_tokens: s.cacheWrite, output_tokens: s.output };
}

function usageStats(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { cost: null, peakContext: null, cacheReadShare: null };
  let cost = 0;
  let priced = true;
  let peak = 0;
  let read = 0;
  let prompt = 0;
  for (const s of steps) {
    const step = costForUsage(stepUsage(s), s.model, s.t);
    cost += step.cost;
    // An unknown model prices at $0, so one such step makes the whole total too low.
    if (!step.priced) priced = false;
    const context = s.input + s.cacheRead + s.cacheWrite;
    peak = Math.max(peak, context);
    read += s.cacheRead;
    prompt += context;
  }
  return { cost: priced ? cost : null, peakContext: peak, cacheReadShare: prompt > 0 ? read / prompt : null };
}

// A path counts as named when the image text holds its full path or its path relative to the worktree.
// The image file itself never counts: every worker reads it, and its text does not hold its own path.
function readsOutside(reads, worktree, imageText, imagePath) {
  if (!Array.isArray(reads)) return null;
  const prefix = worktree ? (worktree.endsWith('/') ? worktree : `${worktree}/`) : null;
  return reads.filter((file) => {
    if (file === imagePath || imageText.includes(file)) return false;
    return !(prefix && file.startsWith(prefix) && imageText.includes(file.slice(prefix.length)));
  });
}

// The agent's end: its last step, else its last DONE, KILLED or FAILED watch event, else the run's end.
function agentEnd(agent, steps, events, runEnd) {
  const list = steps[agent];
  if (Array.isArray(list) && list.length > 0) return Math.max(...list.map((s) => s.t));
  const done = events.filter((e) => e.kind === 'watch' && e.agent === agent && ENDING.includes(e.name));
  return done.length ? ms(done[done.length - 1]) : runEnd;
}

function agentRows(events, steps, reads, imageText, imagePath, queueOf, runEnd) {
  const rows = [];
  const seen = new Set();
  for (const e of events) {
    if (e.kind !== 'claimed' || typeof e.agent !== 'string' || seen.has(e.agent)) continue;
    seen.add(e.agent);
    const start = ms(e);
    rows.push({
      agent: e.agent,
      file: e.file ?? null,
      queue: queueOf.get(e.file) ?? null,
      ...usageStats(steps[e.agent]),
      readOutsideImage: readsOutside(reads[e.agent], e.worktree, imageText, imagePath),
      startMs: start,
      endMs: Math.max(start, agentEnd(e.agent, steps, events, runEnd)),
    });
  }
  return rows;
}

function buildReport({ events, steps = {}, reads = {}, imageText = '', imagePath = null }) {
  const times = events.map(ms);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) : null;
  const queueOf = new Map(events.filter((e) => e.kind === 'added').map((e) => [e.file, e.queue]));
  const agents = agentRows(events, steps, reads, imageText, imagePath, queueOf, end ?? 0);
  const costs = agents.map((a) => a.cost).filter((c) => c !== null);
  const length = start === null ? 0 : end - start;
  const running = agents.reduce((sum, a) => sum + (a.endMs - a.startMs), 0);
  return {
    run: {
      start: start === null ? null : new Date(start).toISOString(),
      end: end === null ? null : new Date(end).toISOString(),
      agents: agents.length,
      cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      meanRunning: length > 0 ? running / length : null,
    },
    tasks: start === null ? [] : taskRows(events, queueOf, end),
    agents: agents.map(({ startMs, endMs, ...row }) => row),
  };
}

function duration(v) {
  if (v === null || v === undefined) return 'n/a';
  const s = Math.round(v / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

const money = (v) => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
const num = (v) => (v === null ? 'n/a' : v.toLocaleString('en-US'));
const percent = (v) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

function table(head, rows) {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

function watchText(w) {
  const parts = Object.entries(w).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(', ') : '-';
}

function renderReport(report) {
  const { run } = report;
  const lines = [
    `Run: ${run.start ?? 'n/a'} to ${run.end ?? 'n/a'}, ${run.agents} agents, cost ${money(run.cost)}, mean running ${run.meanRunning === null ? 'n/a' : run.meanRunning.toFixed(1)}`,
    '',
    table(
      ['Task', 'Attempts', 'Pass', 'Fail', 'Steers', 'Denied', 'Slot wait', 'Wall', 'Waiting', 'Watch'],
      report.tasks.map((t) => [taskLabel(t.task, t.title), t.attempts, t.reviewPass, t.reviewFail, t.steers, t.denied, duration(t.slotWaitMs), duration(t.wallMs), duration(t.waitingMs), watchText(t.watch)]),
    ),
    '',
    table(
      ['Agent', 'File', 'Cost', 'Peak context', 'Cache read', 'Read outside image'],
      report.agents.map((a) => [a.agent, a.file ?? 'n/a', money(a.cost), num(a.peakContext), percent(a.cacheReadShare), a.readOutsideImage === null ? 'n/a' : a.readOutsideImage.length ? a.readOutsideImage.join(', ') : 'none']),
    ),
  ];
  return lines.join('\n') + '\n';
}

module.exports = { buildReport, renderReport };
