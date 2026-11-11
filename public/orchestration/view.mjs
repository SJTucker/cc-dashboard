// The Orchestration tab's view-model helpers: pure functions from data to the
// words, numbers and class names the renderer draws. No DOM here, so node can
// import this module (test/modules-load.test.js).
import { formatDuration } from '../format.mjs';

export const CONTEXT_BUDGET = 200000;
export const EMPTY_TEXT = 'No orchestration ran today. Start one with the orchestrate skill.';

const STATUS_VIEWS = {
  working: { glyph: '●', word: 'Working', tone: 'live' },
  review: { glyph: '◐', word: 'In review', tone: 'plain' },
  changes: { glyph: '◐', word: 'Changes asked', tone: 'plain' },
  passed: { glyph: '✓', word: 'Passed', tone: 'plain' },
  merged: { glyph: '✓', word: 'Merged', tone: 'plain' },
  done: { glyph: '✓', word: 'Done', tone: 'plain' },
  stuck: { glyph: '!', word: 'Stuck', tone: 'warn' },
  quiet: { glyph: '○', word: 'Quiet', tone: 'plain' },
  starting: { glyph: '○', word: 'Starting', tone: 'plain' },
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

const ATTENTION = new Set(['STUCK', 'DRIFT', 'BUDGET']);

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
