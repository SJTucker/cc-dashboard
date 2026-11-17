// The Orchestration tab's view-model helpers: pure functions from data to the
// words, numbers and class names the renderer draws. No DOM here, so node can
// import this module (test/modules-load.test.js).
import { formatDuration, formatTokens } from '../format.mjs';

export const CONTEXT_BUDGET = 200000;
export const EMPTY_TEXT = 'No orchestration ran today. Start one with the orchestrate skill.';

const STATUS_VIEWS = {
  working: { glyph: '●', word: 'Working', tone: 'live' },
  review: { glyph: '◐', word: 'In review', tone: 'plain' },
  changes: { glyph: '↺', word: 'Changes asked', tone: 'plain' },
  passed: { glyph: '✓', word: 'Passed', tone: 'plain' },
  merged: { glyph: '✓', word: 'Merged', tone: 'plain' },
  done: { glyph: '✓', word: 'Done', tone: 'plain' },
  stuck: { glyph: '!', word: 'Stuck', tone: 'warn' },
  quiet: { glyph: '○', word: 'Quiet', tone: 'plain' },
  starting: { glyph: '◌', word: 'Starting', tone: 'plain' },
};

// { glyph, word, tone } for a worker status. Every status has a shape and a word,
// so no state depends on colour.
export function statusView(status) {
  return STATUS_VIEWS[status] ?? { glyph: '○', word: String(status), tone: 'plain' };
}

// True for what shortAgo returns under a minute: "30s".
export function isSeconds(ago) {
  return /^\d+s$/.test(ago);
}

// "just now" under a minute, else "2h ago". shortAgo answers "<n>s" under a minute.
function agoWords(summary, now) {
  const ago = shortAgo(summary.lastActiveAt, now);
  return isSeconds(ago) ? 'just now' : `${ago} ago`;
}

// The switcher card's one-line state.
export function switcherState(summary, now = Date.now()) {
  if (summary.waiting) return 'Waiting for you';
  if (!summary.live) return `${summary.phase === 'finish' ? 'Finished' : 'Ended'} ${agoWords(summary, now)}`;
  if (summary.phase === 'waves') return summary.wave ? `Wave ${summary.wave}` : 'Waves';
  if (summary.phase === 'plan') return 'Planning';
  if (summary.phase === 'reset') return 'Reset';
  return 'Finishing';
}

// Context size as a 0 to 1 share of the budget.
export function meterRatio(tokens) {
  if (!tokens) return 0;
  return Math.min(tokens / CONTEXT_BUDGET, 1);
}

const PHASES = [['plan', 'Plan'], ['reset', 'Reset'], ['waves', 'Waves'], ['finish', 'Finish']];

// The four-step phase track: each step is done, now or todo. A finished
// orchestration with no live session has every step done.
export function phaseSteps(phase, live) {
  const at = PHASES.findIndex(([key]) => key === phase);
  const current = phase === 'finish' && !live ? PHASES.length : at;
  return PHASES.map(([, name], i) => ({ name, state: i < current ? 'done' : i === current ? 'now' : 'todo' }));
}

// "2 working · 1 merged": the non-zero worker counts of a Summary.
export function countsLine(counts) {
  const parts = [];
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.review) parts.push(`${counts.review} in review`);
  if (counts.merged) parts.push(`${counts.merged} merged`);
  if (counts.attention) parts.push(`${counts.attention} need attention`);
  return parts.join(' · ') || 'no workers yet';
}

// "12s", "4m", "2h" since an ISO time or epoch ms.
export function shortAgo(time, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(time).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// One line describing a worker step: the tool and its target, or the text said.
export function stepLabel(step) {
  if (step.tool) return `${step.tool} ${step.text ?? ''}`.trim();
  if (step.kind === 'user') return 'Prompt';
  return firstLine(step.text);
}

export function firstLine(text, max = 110) {
  const line = String(text ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function clock(time) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// A board post's time: "4m ago" under an hour, then the same 24-hour clock the
// actions feed uses.
export function postTime(time, now = Date.now()) {
  const ago = shortAgo(time, now);
  if (isSeconds(ago)) return 'just now';
  return ago.endsWith('m') ? `${ago} ago` : clock(time);
}

// The review row text: "◐ Reviewer running · 2m".
export function reviewLabel(review, now = Date.now()) {
  const view = statusView(review.status === 'running' ? 'review' : review.status);
  const word = review.status === 'running' ? 'running' : view.word.toLowerCase();
  const start = Date.parse(review.startedAt);
  // Only a running review counts up. A settled one with no end time shows a dash.
  const end = review.endedAt ? Date.parse(review.endedAt) : review.status === 'running' ? now : NaN;
  const time = Number.isNaN(start) || Number.isNaN(end) ? '—' : formatDuration(Math.max(0, end - start));
  return `${view.glyph} Reviewer ${word} · ${time}`;
}

// { word, tone } for a worker's lastSteer, or null when it has none. Warn states
// say what went wrong in words.
export function steerView(lastSteer) {
  if (!lastSteer) return null;
  switch (lastSteer.state) {
    case 'pending': return { word: 'Sending…', tone: 'plain' };
    case 'delivered': return { word: `Delivered ${clock(lastSteer.at)}`, tone: 'plain' };
    case 'failed':
      if (lastSteer.reason === 'expired') return { word: 'Not sent: it reached the orchestrator too late. Send it again.', tone: 'warn' };
      // These two reasons are written by mod/hooks/steer.ts.
      if (lastSteer.reason === 'timed out (it may still arrive)') return { word: 'Not confirmed: the send timed out. It may still arrive, so check the worker before sending again.', tone: 'warn' };
      if (lastSteer.reason === 'invalid request') return { word: 'Not sent: the request was not valid. Send it again.', tone: 'warn' };
      return { word: lastSteer.reason ? `Not delivered: ${lastSteer.reason}` : 'Not delivered', tone: 'warn' };
    case 'unclaimed': return { word: 'Not picked up. Is the orchestrator session still open?', tone: 'warn' };
    default: return null;
  }
}

// The message under the board composer after a refused post.
export function boardError(status, data, title = '') {
  if (status === 409 && data?.error === 'no board yet') return 'This orchestration has no board yet. It gets one when the context image is written.';
  if (status === 400 || status === 413) return title.trim() ? 'The title or details are too long.' : 'Write a title first.';
  return `Could not post. The server said ${status}.`;
}

// The message under the steer composer after a refused steer.
export function steerError(status, data, text = '') {
  if (status === 409 && data?.error === 'worker finished') return 'This worker has finished, so it was not steered.';
  if (status === 409 && data?.error === 'orchestrator not live') return 'The orchestrator session is not running, so nothing can deliver the message.';
  if (status === 400 || status === 413) return text.trim() ? 'The message is too long or not valid.' : 'Write a message first.';
  return `Could not send. The server said ${status}.`;
}

const ATTENTION = new Set(['STUCK', 'DRIFT', 'BUDGET', 'CLAIM', 'KILLED', 'FAILED']);

// What a worker card shows as its current action: the latest attention event for
// a stuck worker, the report once the worker has reported, else its latest step.
export function actionText(w) {
  if (w.status === 'stuck') {
    const event = [...(w.events ?? [])].reverse().find((e) => ATTENTION.has(e.type));
    if (event) return event.text;
  }
  if (w.report && w.status !== 'working' && w.status !== 'quiet') return `Report ${firstLine(w.report, 90)}`;
  if (w.current) return stepLabel(w.current);
  return statusView(w.status).word;
}

export function dotClass(live, waiting) {
  return waiting ? 'orch-dot wait' : live ? 'orch-dot' : 'orch-dot off';
}

// The age of one step in the expanded list: "now" for the newest, else "4m ago".
export function stepAge(i, time, now) {
  return i === 0 ? 'now' : `${shortAgo(time, now)} ago`;
}

// The posts from others that the viewer has not seen. board is newest first, and
// seen is how many posts from others were seen. The owner's own posts are never new.
export function unseenPosts(board, seen) {
  const others = board.filter((post) => post.from !== 'You');
  return new Set(others.slice(0, Math.max(0, others.length - seen)));
}

// How many posts of a board come from others: the count stored as seen.
export function othersCount(board) {
  return board.filter((post) => post.from !== 'You').length;
}

// "T3" for a worker with a task number, else "".
export function taskLabel(worker) {
  return worker.task == null ? '' : `T${worker.task}`;
}

// ---------- The redesigned tab ----------

// The context size where the meter turns amber. It matches LARGE_CONTEXT_TOKENS in
// lib/aggregate.js, the line Claude Code's own usage view draws.
export const CONTEXT_WARN = 150000;

const wholeK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// The context meter's words and fill: "63.2k", "137k left" or "12k over", the 0 to 1
// ratio of the budget, and whether the size is at the warning line.
export function contextView(tokens) {
  if (tokens == null) return { value: '—', left: '', ratio: 0, warn: false };
  const left = CONTEXT_BUDGET - tokens;
  return {
    value: formatTokens(tokens),
    left: left >= 0 ? `${wholeK(left)} left` : `${wholeK(-left)} over`,
    ratio: meterRatio(tokens),
    warn: tokens >= CONTEXT_WARN,
  };
}

// The same rule as isTaskFile in lib/transcript-index.js: a planned entry ending in /
// is a folder, else a path equals the entry or ends with /<entry>.
function isPlanned(path, files) {
  return files.some((f) => (f.endsWith('/') ? path.startsWith(f) || path.includes(`/${f}`) : path === f || path.endsWith(`/${f}`)));
}

// One cell per planned file, touched or not, and the edited paths outside the plan.
// files are plan-relative, touched and edited are absolute worktree paths.
export function filesView(worker) {
  const files = worker.files ?? [];
  const touched = worker.touched ?? [];
  const cells = files.map((path) => ({ path, touched: touched.some((t) => isPlanned(t, [path])) }));
  const outside = (worker.edited ?? []).filter((f) => !touched.includes(f));
  return { cells, outside };
}

const ROUND_WORDS = { passed: 'passed', changes: 'changes asked', running: 'in review' };

// The merged row's review history: "passed first time", "no review" or the rounds
// joined with ", then ". Repeats of one round collapse into "×2".
export function reviewHistory(reviews) {
  if (!reviews?.length) return 'no review';
  if (reviews.length === 1 && reviews[0].status === 'passed') return 'passed first time';
  const runs = [];
  for (const { status } of reviews) {
    if (runs.at(-1)?.status === status) runs.at(-1).n += 1;
    else runs.push({ status, n: 1 });
  }
  return runs.map(({ status, n }) => `${ROUND_WORDS[status] ?? status}${n > 1 ? ` ×${n}` : ''}`).join(', then ');
}

// "4m" between two ISO times, or a dash when either is missing.
export function tookLabel(startIso, endIso) {
  const start = startIso ? Date.parse(startIso) : NaN;
  const end = endIso ? Date.parse(endIso) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  return formatDuration(Math.max(0, end - start));
}

// The length of each wave in ms, or null when unknown. A wave ends at its endedAt, else
// where the next wave starts. The last wave of a live run with no endedAt runs until now.
export function waveSpans(waves, { live, now }) {
  return waves.map((w, i) => {
    const start = w.startedAt ? Date.parse(w.startedAt) : NaN;
    const isLast = i === waves.length - 1;
    let end = NaN;
    let running = false;
    if (w.endedAt) end = Date.parse(w.endedAt);
    else if (!isLast) end = waves[i + 1].startedAt ? Date.parse(waves[i + 1].startedAt) : NaN;
    else if (live) {
      end = now;
      running = true;
    }
    const ms = Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
    return { n: w.n, startedAt: w.startedAt, ms, running };
  });
}

// Folds each run of consecutive routine ("·") feed entries into one group. A group's
// key is its oldest entry's key, so it holds when newer entries arrive. The feed is
// newest first, so the oldest entry of a group is its last.
export function foldFeed(feed) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const oldest = run.at(-1);
    const newest = run[0];
    const label = run.length === 1
      ? `1 routine check · ${clock(oldest.at)}`
      : `${run.length} routine checks · ${clock(oldest.at)}–${clock(newest.at)}`;
    out.push({ kind: 'group', key: `g:${oldest.at}|${oldest.line}`, entries: run, label });
    run = [];
  };
  for (const entry of feed ?? []) {
    if (entry.glyph === '·') run.push(entry);
    else {
      flush();
      out.push({ kind: 'entry', key: `${entry.at}|${entry.line}`, entry });
    }
  }
  flush();
  return out;
}

function latestAttention(worker) {
  return [...(worker.events ?? [])].reverse().find((e) => ATTENTION.has(e.type)) ?? null;
}

function stuckWorkers(detail) {
  return (detail.waves ?? [])
    .flatMap((wave) => wave.workers ?? [])
    .filter((w) => w.status === 'stuck')
    .sort((a, b) => (a.task ?? Infinity) - (b.task ?? Infinity));
}

// What needs the owner: the orchestrator's question when the live run is waiting, then
// each stuck worker in task order with its latest attention event.
export function attentionItems(detail) {
  const items = [];
  if (detail.live && detail.now?.state === 'waiting') items.push({ kind: 'waiting', text: detail.now.detail ?? '', since: detail.now.since });
  for (const worker of stuckWorkers(detail)) {
    const event = latestAttention(worker);
    if (event) items.push({ kind: 'stuck', worker, event: { type: event.type, text: event.text, at: event.at } });
  }
  return items;
}

// The run switcher card's pill, meta line, phase pips and counts.
export function runCard(summary, now = Date.now()) {
  const pill = summary.waiting
    ? { glyph: '⏸', text: 'Waiting for you', tone: 'warn' }
    : summary.live
      ? { glyph: '●', text: 'Live', tone: 'live' }
      : { glyph: '○', text: switcherState(summary, now), tone: 'plain' };
  const meta = [summary.project];
  if (summary.branch) meta.push(summary.branch);
  if (summary.wave != null) meta.push(`wave ${summary.wave}`);
  if (summary.lastActiveAt != null) meta.push(`last active ${clock(summary.lastActiveAt)}`);
  meta.push(`board ${summary.boardCount ?? 0}`);
  const pips = phaseSteps(summary.phase, summary.live).map((step) => {
    const state = step.state === 'todo' ? 'next' : step.state;
    return { name: step.name, state, wait: state === 'now' && Boolean(summary.waiting) };
  });
  const c = summary.counts ?? {};
  const count = (glyph, word, n, warn = false) => ({ glyph, word, n: n ?? 0, tone: n ? (warn ? 'warn' : 'plain') : 'zero' });
  const counts = [count('●', 'working', c.working), count('◐', 'review', c.review), count('✓', 'merged', c.merged), count('!', 'attention', c.attention, true)];
  return { pill, meta: meta.filter((x) => x != null && x !== ''), pips, counts };
}

const STEER_STATES = {
  pending: { glyph: '◌', word: 'Pending' },
  delivered: { glyph: '✓', word: 'Delivered' },
  unclaimed: { glyph: '○', word: 'Unclaimed' },
  failed: { glyph: '✕', word: 'Failed' },
};
export const STEER_DRAIN_MS = 30000;

// The steer row of a worker card, or null with no steer. drainMs is the time left of
// the 30 s a pending steer is expected to take, clamped to 0..30000.
export function steerState(lastSteer, now = Date.now()) {
  const view = lastSteer && STEER_STATES[lastSteer.state];
  if (!view) return null;
  const pending = lastSteer.state === 'pending';
  const failedLike = lastSteer.state === 'failed' || lastSteer.state === 'unclaimed';
  // at is epoch ms from the server, or an ISO string.
  const age = now - new Date(lastSteer.at).getTime();
  return {
    glyph: view.glyph,
    word: view.word,
    sub: pending ? 'Waiting for the orchestrator session to pick it up.' : failedLike ? steerView(lastSteer).word : '',
    again: failedLike,
    drainMs: pending && !Number.isNaN(age) ? Math.min(STEER_DRAIN_MS, Math.max(0, STEER_DRAIN_MS - age)) : 0,
  };
}

// The attention banner's line under a stuck worker, from its lastSteer.
export function steerMeta(lastSteer) {
  if (!lastSteer) return '';
  if (lastSteer.state === 'pending') return `Your steer from ${clock(lastSteer.at)} is waiting for pickup.`;
  if (lastSteer.state === 'delivered') return `Steer delivered at ${clock(lastSteer.at)}. Watching for a change.`;
  return steerView(lastSteer)?.word ?? '';
}

// The status block's now line: waiting, else the first stuck task, else what is running.
export function nowView(detail) {
  const n = detail.now ?? {};
  const since = n.since ? `since ${clock(n.since)}` : '';
  if (detail.live && n.state === 'waiting') return { glyph: '?', text: 'Waiting for you', since, tone: 'warn' };
  const stuck = stuckWorkers(detail)[0];
  if (stuck) {
    const event = latestAttention(stuck);
    return { glyph: '!', text: `${stuck.task == null ? 'A worker' : `Task ${stuck.task}`} stuck, ${event?.type ?? 'STUCK'}`, since, tone: 'warn' };
  }
  if (!detail.live) return { glyph: '○', text: n.text ?? '', since, tone: 'plain' };
  return { glyph: '●', text: n.text ?? '', since, tone: 'live' };
}
