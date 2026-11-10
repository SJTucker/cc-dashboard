// Draws the Orchestration tab: the switcher across the top, then the selected
// orchestration's orchestrator panel, workers, actions feed and board. Both render
// functions update existing nodes by data-key and create or remove only what
// changed, so a poll that changes one worker leaves the rest of the page alone.
// Nothing here touches the DOM at import time.
import { el } from '../dom.mjs';
import { formatAgo, formatDuration, formatTokens } from '../format.mjs';
import { enter, fadeIn, swapText } from './motion.mjs';

export const CONTEXT_BUDGET = 120000;
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

// The switcher card's one-line state.
export function switcherState(summary, now = Date.now()) {
  if (summary.waiting) return 'Waiting for you';
  if (summary.phase === 'waves') return `Wave ${summary.wave}`;
  if (summary.phase === 'finish' && !summary.live) return `Finished ${formatAgo(summary.lastActiveAt, now)}`;
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

function firstLine(text, max = 110) {
  const line = String(text ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function clock(time) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

const ATTENTION = new Set(['STUCK', 'DRIFT', 'BUDGET']);

// What a worker card shows as its current action: the latest attention event for
// a stuck worker, the report once the worker has reported, else its latest step.
function actionText(w) {
  if (w.status === 'stuck') {
    const event = [...(w.events ?? [])].reverse().find((e) => ATTENTION.has(e.type));
    if (event) return event.text;
  }
  if (w.report && w.status !== 'working' && w.status !== 'quiet') return `Report ${firstLine(w.report, 90)}`;
  if (w.current) return stepLabel(w.current);
  return statusView(w.status).word;
}

// Brings the keyed children of parent in line with items: creates missing ones,
// updates all, orders them as items are, removes the rest. A repeated key gets a
// numeric suffix. Returns the nodes it created.
function reconcile(parent, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of parent.children) existing.set(child.dataset.key, child);
  const used = new Set();
  const created = [];
  let previous = null;
  for (const item of items) {
    const base = keyOf(item);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}#${n}`;
    used.add(key);
    let node = existing.get(key);
    if (!node) {
      node = create(item);
      node.dataset.key = key;
      created.push(node);
    }
    update(node, item);
    const wanted = previous ? previous.nextSibling : parent.firstChild;
    if (node !== wanted) parent.insertBefore(node, wanted);
    previous = node;
  }
  for (const [key, child] of existing) if (!used.has(key)) child.remove();
  return created;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, name, on) {
  node.classList.toggle(name, Boolean(on));
}

function dotClass(live, waiting) {
  return waiting ? 'orch-dot wait' : live ? 'orch-dot' : 'orch-dot off';
}

// ---------- Switcher ----------

export function renderSwitcher(root, list, selectedId, onSelect, now = Date.now()) {
  reconcile(
    root,
    list,
    (s) => s.id,
    (s) => {
      const name = el('span', { class: 'run-name' });
      const dot = el('span', { class: 'orch-dot', 'aria-hidden': 'true' });
      const state = el('span', { class: 'run-state' });
      const counts = el('span', { class: 'run-counts' });
      const card = el('button', { class: 'run', type: 'button' }, [
        el('span', { class: 'run-top' }, [dot, name]),
        el('span', { class: 'run-meta' }, [el('span', {}, [state, document.createTextNode(' · '), counts]), el('span', { class: 'run-project' })]),
      ]);
      card._r = { name, dot, state, counts, project: card.querySelector('.run-project') };
      card.addEventListener('click', () => onSelect(card.dataset.key));
      return card;
    },
    (card, s) => {
      const r = card._r;
      setText(r.name, s.topic);
      setText(r.project, s.project);
      setText(r.state, switcherState(s, now));
      setText(r.counts, countsLine(s.counts));
      r.dot.className = dotClass(s.live, s.waiting);
      setClass(r.state, 'wait', s.waiting);
      setClass(card, 'done', !s.live);
      card.setAttribute('aria-pressed', String(s.id === selectedId));
    },
  );
}

// Replaces the detail with one message (no orchestration today, or a failed load).
export function renderEmpty(root, text) {
  delete root.dataset.id;
  root.replaceChildren(el('p', { class: 'orch-empty', text }));
}

// ---------- Detail ----------

function panel(extraClass, title, bodyNodes) {
  const meta = el('span', { class: 'panel-meta' });
  const node = el('section', { class: `panel ${extraClass}` }, [
    el('div', { class: 'panel-head' }, [el('h2', { text: title }), meta]),
    ...bodyNodes,
  ]);
  return { node, meta };
}

function buildSkeleton(root, id) {
  const title = el('h3', { class: 'orch-topic' });
  const project = el('span', { class: 'tagline-project' });
  const branch = el('code');
  const phases = el('div', { class: 'phases' });
  const nowDot = el('span', { class: 'orch-dot', 'aria-hidden': 'true' });
  const nowWhat = el('span', { class: 'what' });
  const nowDetail = el('span', { class: 'detail' });
  const nowSince = el('span', { class: 'since' });
  const nowBox = el('div', { class: 'now-box' }, [nowDot, el('div', { class: 'now-text' }, [nowWhat, nowDetail]), nowSince]);
  const orch = panel('orch', 'Orchestrator', [
    el('div', { class: 'orch-body' }, [
      el('div', { class: 'orch-title' }, [title, el('span', { class: 'tagline' }, [project, document.createTextNode(' · branch '), branch])]),
      phases,
      nowBox,
    ]),
  ]);

  const waves = el('div', { class: 'orch-waves' });
  const wavesEmpty = el('p', { class: 'orch-empty', text: 'Workers show here once the orchestrator starts a wave.' });
  const workers = panel('waves', 'Workers', [waves, wavesEmpty]);

  const feed = el('ul', { class: 'feed' });
  const actions = panel('', 'Orchestrator actions', [el('div', { class: 'feed-wrap' }, [feed])]);
  actions.meta.textContent = 'newest first';

  const boardList = el('ul', { class: 'board-list' });
  const boardEmpty = el('p', { class: 'orch-empty', text: 'Workers post here when they find something that affects other tasks.' });
  const board = panel('board', 'Board', [boardList, boardEmpty]);
  board.node.classList.add('orch-board');

  const layout = el('div', { class: 'orch-layout' }, [
    el('div', { class: 'orch-main' }, [orch.node, workers.node, actions.node]),
    board.node,
  ]);
  root.replaceChildren(layout);
  root.dataset.id = id;
  root._orch = {
    open: new Set(),
    orchMeta: orch.meta, title, project, branch, phases, nowBox, nowDot, nowWhat, nowDetail, nowSince,
    workersMeta: workers.meta, waves, wavesEmpty,
    feed, boardMeta: board.meta, boardList, boardEmpty,
  };
  return root._orch;
}

// Draws one orchestration's Detail. firstRender is true on the first render after
// a selection change, and nothing animates then. seenBoard is how many board posts
// the viewer has already seen.
export function renderDetail(root, detail, { seenBoard = 0, firstRender = false, now = Date.now() } = {}) {
  const fresh = root.dataset.id !== detail.id;
  const r = fresh ? buildSkeleton(root, detail.id) : root._orch;
  const animate = !(firstRender || fresh);

  setText(r.orchMeta, detail.live ? `updated ${formatAgo(now, now)}` : 'ended');
  setText(r.title, detail.topic);
  setText(r.project, detail.project);
  setText(r.branch, detail.branch ?? '');
  renderPhases(r.phases, detail);
  renderNow(r, detail, animate, now);
  renderWaves(r, detail, animate, now);
  renderFeed(r.feed, detail.feed);
  renderBoard(r, detail, seenBoard, animate, now);
}

function renderPhases(node, detail) {
  const steps = phaseSteps(detail.phase, detail.live);
  const labelFor = (step) => {
    const tick = step.state === 'done' ? '✓ ' : '';
    const wave = step.state === 'now' && step.name === 'Waves' && detail.wave ? ` · ${detail.wave}` : '';
    return `${tick}${step.name}${wave}`;
  };
  reconcile(
    node,
    steps,
    (s) => s.name,
    () => el('div', { class: 'phase' }, [el('span', { class: 'bar' }), el('span', { class: 'name' })]),
    (item, s) => {
      item.className = `phase ${s.state === 'todo' ? '' : s.state}`.trim();
      setText(item.querySelector('.name'), labelFor(s));
    },
  );
}

function renderNow(r, detail, animate, now) {
  const n = detail.now;
  const waiting = n.state === 'waiting';
  setClass(r.nowBox, 'wait', waiting);
  r.nowDot.className = dotClass(n.state === 'working' || waiting, waiting);
  swapText(r.nowWhat, n.text, { animate });
  swapText(r.nowDetail, n.detail ?? '', { animate });
  setText(r.nowSince, n.since ? `for ${formatDuration(now - new Date(n.since).getTime())}` : '');
}

// ---------- Workers ----------

function renderWaves(r, detail, animate, now) {
  const waves = detail.waves ?? [];
  const last = waves[waves.length - 1];
  const lastMerged = last && last.workers.every((w) => w.status === 'merged');
  const sections = [];
  if (last && !lastMerged) sections.push({ mode: 'cards', wave: last });
  for (const wave of [...waves].reverse()) {
    if (wave === last && !lastMerged) continue;
    sections.push({ mode: 'chips', wave });
  }

  r.wavesEmpty.hidden = waves.length > 0;
  if (last && !lastMerged) setText(r.workersMeta, `Wave ${last.n} · ${last.workers.length} ${last.workers.length === 1 ? 'task' : 'tasks'}`);
  else setText(r.workersMeta, waves.length ? 'all waves merged' : 'no wave started');

  reconcile(
    r.waves,
    sections,
    (s) => `wave-${s.wave.n}-${s.mode}`,
    (s) => buildWave(s),
    (node, s) => updateWave(node, s, r, animate, now),
  );
}

function buildWave({ mode }) {
  const label = el('span', { class: 'label' });
  const meta = el('span', { class: 'panel-meta' });
  const body = el('div', { class: mode === 'cards' ? 'orch-workers' : 'chips' });
  const node = el('div', { class: `wave${mode === 'cards' ? '' : ' past'}` }, [el('div', { class: 'wave-head' }, [label, meta]), body]);
  node._r = { label, meta, body };
  return node;
}

function updateWave(node, { mode, wave }, r, animate, now) {
  const w = node._r;
  if (mode === 'cards') {
    setText(w.label, `Wave ${wave.n} · now`);
    setText(w.meta, wave.startedAt ? `started ${clock(wave.startedAt)}` : '');
    reconcile(
      w.body,
      wave.workers,
      (worker) => worker.agentId,
      (worker) => buildWorker(worker, r),
      (card, worker) => updateWorker(card, worker, r, animate, now),
    );
    return;
  }
  const merged = wave.workers.filter((worker) => worker.status === 'merged').length;
  setText(w.label, `Wave ${wave.n}`);
  setText(w.meta, `${merged} of ${wave.workers.length} merged`);
  reconcile(
    w.body,
    wave.workers,
    (worker) => worker.agentId,
    () => el('span', { class: 'chip' }),
    (chip, worker) => setText(chip, `${statusView(worker.status).glyph} T${worker.task} ${worker.title ?? ''}`.trim()),
  );
}

function buildWorker(worker, r) {
  const title = el('span', { class: 'w-title' });
  const status = el('span', { class: 'status' });
  const act = el('span', { class: 'act' });
  const since = el('span', { class: 'since' });
  const ctxValue = el('span');
  const fill = el('span', { class: 'fill' });
  const meterNode = el('span', { class: 'meter' }, [fill, el('span', { class: 'tick' })]);
  const foot = el('div', { class: 'w-foot' });
  const head = el('button', { class: 'w-head', type: 'button', 'aria-expanded': 'false' }, [
    el('div', { class: 'w-top' }, [title, status]),
    el('div', { class: 'w-now' }, [act, since]),
    el('div', { class: 'ctx' }, [el('div', { class: 'ctx-row' }, [el('span', { text: 'Context' }), ctxValue]), meterNode]),
    foot,
  ]);
  const more = el('div', { class: 'w-more' });
  more.hidden = true;
  const review = el('div', { class: 'review' });
  review.hidden = true;
  const card = el('div', { class: 'worker' }, [head, review, more]);
  card._r = { head, title, status, act, since, ctxValue, fill, meterNode, foot, more, review, wNow: head.querySelector('.w-now') };
  head.addEventListener('click', () => {
    const id = card.dataset.key;
    const open = !r.open.has(id);
    if (open) r.open.add(id);
    else r.open.delete(id);
    head.setAttribute('aria-expanded', String(open));
    more.hidden = !open;
    if (open) {
      fillMore(card._r, card._worker);
      fadeIn(more, { animate: true });
    }
  });
  return card;
}

function updateWorker(card, w, r, animate, now) {
  const c = card._r;
  card._worker = w;
  const view = statusView(w.status);
  c.title.replaceChildren(el('b', { text: `T${w.task}` }), document.createTextNode(w.title ?? ''));
  c.status.className = `status ${view.tone}`;
  c.status.replaceChildren(el('span', { class: 'glyph', text: view.glyph }), document.createTextNode(view.word));
  setClass(card, 'attn', w.status === 'stuck');
  setClass(c.wNow, 'attn', w.status === 'stuck');
  swapText(c.act, actionText(w), { animate });
  setText(c.since, w.lastActiveAt ? `${shortAgo(w.lastActiveAt, now)} ago` : '');

  setText(c.ctxValue, `${w.contextTokens ? formatTokens(w.contextTokens) : '—'} / ${formatTokens(CONTEXT_BUDGET)}`);
  c.fill.style.transform = `scaleX(${meterRatio(w.contextTokens)})`;
  setClass(c.fill, 'over', w.contextTokens > CONTEXT_BUDGET);

  const edited = (w.edited ?? []).filter((f) => (w.files ?? []).includes(f)).length;
  const finished = ['merged', 'done', 'passed', 'changes', 'review'].includes(w.status);
  const end = finished && w.lastActiveAt ? new Date(w.lastActiveAt).getTime() : now;
  c.foot.replaceChildren(
    footItem('Files', `${edited} of ${(w.files ?? []).length}`),
    footItem('Running', formatDuration(Math.max(0, end - new Date(w.startedAt).getTime()))),
  );

  c.review.hidden = !w.review;
  if (w.review) {
    const reviewView = statusView(w.review.status === 'running' ? 'review' : w.review.status);
    c.review.replaceChildren(
      el('span', { text: `${reviewView.glyph} Reviewer ${reviewView.word.toLowerCase()} · ${formatDuration(Math.max(0, now - new Date(w.review.startedAt).getTime()))}` }),
      el('span', { text: `Task ${w.task}` }),
    );
  }
  const open = r.open.has(card.dataset.key);
  c.head.setAttribute('aria-expanded', String(open));
  c.more.hidden = !open;
  if (open) fillMore(c, w);
}

function footItem(label, value) {
  return el('span', {}, [document.createTextNode(`${label} `), el('b', { class: 'num', text: value })]);
}

function fillMore(c, w) {
  const steps = [...(w.steps ?? [])].reverse();
  const now = Date.now();
  c.more.replaceChildren(
    el('span', { class: 'label more-label', text: 'Last steps' }),
    el('ul', { class: 'steps' }, steps.map((s, i) => el('li', {}, [
      el('span', { text: i === 0 ? 'now' : `-${shortAgo(s.time, now)}` }),
      el('span', { text: stepLabel(s) }),
    ]))),
    el('div', { class: 'done-check' }, [document.createTextNode('Done when '), el('code', { text: w.doneWhen ?? 'not stated' })]),
  );
}

// ---------- Feed and board ----------

function renderFeed(node, feed) {
  reconcile(
    node,
    feed ?? [],
    (f) => `${f.at}|${f.line}`,
    () => el('li', {}, [el('span', { class: 't' }), el('span', { class: 'g' }), el('span', { class: 'x' })]),
    (li, f) => {
      const [t, g, x] = li.children;
      setText(t, clock(f.at));
      setText(g, f.glyph);
      x.replaceChildren(document.createTextNode(f.text), ...(f.detail ? [el('span', { text: ` · ${f.detail}` })] : []));
    },
  );
}

function renderBoard(r, detail, seenBoard, animate, now) {
  const board = detail.board ?? [];
  const unseen = Math.max(0, board.length - seenBoard);
  setText(r.boardMeta, `${board.length} ${board.length === 1 ? 'post' : 'posts'}${unseen ? ` · ${unseen} new` : ''}`);
  r.boardEmpty.hidden = board.length > 0;
  const total = board.length;
  const created = reconcile(
    r.boardList,
    board.map((post, i) => ({ post, isNew: total - i > seenBoard })),
    ({ post }) => `${post.t}${post.from}`,
    ({ post }) => buildPost(post),
    (li, { post, isNew }) => {
      const p = li._r;
      setText(p.from, post.from);
      setClass(p.from, 'you', post.from === 'You');
      setText(p.when, formatAgo(new Date(post.t).getTime(), now));
      setText(p.title, post.title);
      setText(p.body, post.body ?? '');
      if (isNew) li.classList.add('new');
      else if (li.classList.contains('new')) li.classList.add('seen');
    },
  );
  for (const li of created) enter(li, { animate });
}

function buildPost(post) {
  const from = el('span', { class: 'post-from' });
  const when = el('span', { class: 'muted' });
  const title = el('span', { class: 'post-title' });
  const body = el('span', { class: 'post-body' });
  const children = [el('div', { class: 'post-top' }, [from, when]), title, body];
  const li = el('li', { class: 'post' }, children);
  li._r = { from, when, title, body };
  if ((post.body ?? '').length > 120 || (post.body ?? '').includes('\n')) {
    const more = el('button', { class: 'more', type: 'button', text: 'Show all' });
    more.addEventListener('click', () => {
      li.classList.toggle('open');
      more.textContent = li.classList.contains('open') ? 'Show less' : 'Show all';
    });
    li.appendChild(more);
  }
  return li;
}
