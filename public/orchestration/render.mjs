// Draws the Orchestration tab: the switcher across the top, then the selected
// orchestration's orchestrator panel, workers, actions feed and board. Both render
// functions update existing nodes by data-key and create or remove only what
// changed, so a poll that changes one worker leaves the rest of the page alone.
// Nothing here touches the DOM at import time.
import { el } from '../dom.mjs';
import { formatDuration, formatTokens } from '../format.mjs';
import { enter, fadeIn, swapText } from './motion.mjs';
import {
  CONTEXT_BUDGET, actionText, boardError, clock, countsLine, dotClass, meterRatio, phaseSteps, postTime,
  reviewLabel, shortAgo, statusView, stepAge, stepLabel, steerError, steerView, switcherState,
} from './view.mjs';

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
  // A board post the owner just sent has no entry in items until a poll reads it.
  for (const [key, child] of existing) if (!used.has(key) && !child.hasAttribute('data-pending')) child.remove();
  return created;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, name, on) {
  node.classList.toggle(name, Boolean(on));
}

// ---------- Switcher ----------

export function renderSwitcher(root, list, selectedId, onSelect, now = Date.now()) {
  reconcile(
    root,
    list,
    (s) => s.id,
    () => {
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
  const composer = buildBoardComposer(root);
  board.node.appendChild(composer.node);

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
    feed, boardMeta: board.meta, boardList, boardEmpty, composer,
    root,
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

  setText(r.orchMeta, detail.live ? 'live' : 'ended');
  setText(r.title, detail.topic);
  setText(r.project, detail.project);
  setText(r.branch, detail.branch ?? '');
  renderPhases(r.phases, detail);
  renderNow(r, detail, animate, now);
  r.live = detail.live;
  renderWaves(r, detail, animate, now);
  renderFeed(r.feed, detail.feed);
  renderBoard(r, detail, seenBoard, animate, now);
  r.composer.node.hidden = !detail.live;
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
    buildWave,
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
      () => buildWorker(r),
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

// A worker card. Every node below is built once and updated in place on each poll,
// so a text selection or an open composer survives it. .w-slot holds the steer
// status row and composer, which buildSteer builds once.
function buildWorker(r) {
  const filesValue = el('b', { class: 'num' });
  const steerValue = el('b', { class: 'num' });
  const steerItem = el('span', {}, [document.createTextNode('Steered '), steerValue]);
  const runningValue = el('b', { class: 'num' });
  const r2 = {
    taskNo: el('b'),
    titleText: el('span'),
    glyph: el('span', { class: 'glyph' }),
    word: el('span'),
    act: el('span', { class: 'act' }),
    since: el('span', { class: 'since' }),
    ctxValue: el('span'),
    fill: el('span', { class: 'fill' }),
    filesValue, steerValue, steerItem, runningValue,
    reviewText: el('span'),
    reviewTask: el('span'),
    moreList: el('ul', { class: 'steps' }),
    doneWhen: el('code'),
  };
  r2.title = el('span', { class: 'w-title' }, [r2.taskNo, r2.titleText]);
  r2.status = el('span', { class: 'status' }, [r2.glyph, r2.word]);
  r2.wNow = el('div', { class: 'w-now' }, [r2.act, r2.since]);
  const head = el('button', { class: 'w-head', type: 'button', 'aria-expanded': 'false' }, [
    el('div', { class: 'w-top' }, [r2.title, r2.status]),
    r2.wNow,
    el('div', { class: 'ctx' }, [
      el('div', { class: 'ctx-row' }, [el('span', { text: 'Context' }), r2.ctxValue]),
      el('span', { class: 'meter' }, [r2.fill, el('span', { class: 'tick' })]),
    ]),
    el('div', { class: 'w-foot' }, [el('span', {}, [document.createTextNode('Files '), filesValue]), steerItem, el('span', {}, [document.createTextNode('Running '), runningValue])]),
  ]);
  const more = el('div', { class: 'w-more' }, [
    el('span', { class: 'label more-label', text: 'Last steps' }),
    r2.moreList,
    el('div', { class: 'done-check' }, [document.createTextNode('Done when '), r2.doneWhen]),
  ]);
  more.hidden = true;
  const review = el('div', { class: 'review' }, [r2.reviewText, r2.reviewTask]);
  review.hidden = true;
  const steer = buildSteer(r, () => card);
  const card = el('div', { class: 'worker' }, [head, review, steer.node, more]);
  Object.assign(r2, { head, more, review, steer });
  card._r = r2;
  head.addEventListener('click', () => {
    const id = card.dataset.key;
    const open = !r.open.has(id);
    if (open) r.open.add(id);
    else r.open.delete(id);
    head.setAttribute('aria-expanded', String(open));
    more.hidden = !open;
    if (open) {
      fillMore(card._r, card._worker, Date.now());
      fadeIn(more, { animate: true });
    }
  });
  return card;
}

function updateWorker(card, w, r, animate, now) {
  const c = card._r;
  card._worker = w;
  card._live = r.live;
  const view = statusView(w.status);
  setText(c.taskNo, `T${w.task}`);
  setText(c.titleText, w.title ?? '');
  c.status.className = `status ${view.tone}`;
  setText(c.glyph, view.glyph);
  setText(c.word, view.word);
  setClass(card, 'attn', w.status === 'stuck');
  setClass(c.wNow, 'attn', w.status === 'stuck');
  swapText(c.act, actionText(w), { animate });
  setText(c.since, w.lastActiveAt ? `${shortAgo(w.lastActiveAt, now)} ago` : '');

  setText(c.ctxValue, `${w.contextTokens ? formatTokens(w.contextTokens) : '—'} / ${formatTokens(CONTEXT_BUDGET)}`);
  c.fill.style.transform = `scaleX(${meterRatio(w.contextTokens)})`;
  setClass(c.fill, 'over', w.contextTokens > CONTEXT_BUDGET);

  const finished = ['merged', 'done', 'passed', 'changes', 'review'].includes(w.status);
  const end = finished && w.lastActiveAt ? new Date(w.lastActiveAt).getTime() : now;
  setText(c.filesValue, `${(w.touched ?? []).length} of ${(w.files ?? []).length}`);
  c.steerItem.hidden = !(w.steerCount > 0);
  setText(c.steerValue, String(w.steerCount ?? 0));
  setText(c.runningValue, formatDuration(Math.max(0, end - new Date(w.startedAt).getTime())));

  c.review.hidden = !w.review;
  if (w.review) {
    setText(c.reviewText, reviewLabel(w.review, now));
    setText(c.reviewTask, `Task ${w.task}`);
  }
  updateSteer(card, w, animate);
  const open = r.open.has(card.dataset.key);
  c.head.setAttribute('aria-expanded', String(open));
  c.more.hidden = !open;
  if (open) fillMore(c, w, now);
}

function fillMore(c, w, now) {
  const steps = [...(w.steps ?? [])].reverse().map((step, i) => ({ step, i }));
  reconcile(
    c.moreList,
    steps,
    ({ step }) => String(step.line),
    () => el('li', {}, [el('span'), el('span')]),
    (li, { step, i }) => {
      setText(li.children[0], stepAge(i, step.time, now));
      setText(li.children[1], stepLabel(step));
    },
  );
  setText(c.doneWhen, w.doneWhen ?? 'not stated');
}

// ---------- Feed and board ----------

function renderFeed(node, feed) {
  reconcile(
    node,
    feed ?? [],
    (f) => `${f.at}|${f.line}`,
    () => el('li', {}, [el('span', { class: 't' }), el('span', { class: 'g' }), el('span', { class: 'x' }, [el('span', { class: 'what' }), el('span', { class: 'detail' })])]),
    (li, f) => {
      const [t, g, x] = li.children;
      setText(t, clock(f.at));
      setText(g, f.glyph);
      setText(x.children[0], f.text);
      x.children[1].hidden = !f.detail;
      setText(x.children[1], f.detail ? ` · ${f.detail}` : '');
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
      fillPost(li, post, now);
      li.removeAttribute('data-pending');
      if (isNew) li.classList.add('new');
      else if (li.classList.contains('new')) li.classList.add('seen');
    },
  );
  for (const li of created) enter(li, { animate });
  // Posts still waiting for a poll to confirm them stay at the top.
  const pending = [...r.boardList.querySelectorAll(':scope > [data-pending]')];
  for (const li of pending.reverse()) if (li !== r.boardList.firstChild) r.boardList.prepend(li);
  r.boardEmpty.hidden = board.length > 0 || pending.length > 0;
}

function fillPost(li, post, now) {
  const p = li._r;
  setText(p.from, post.from);
  setClass(p.from, 'you', post.from === 'You');
  setText(p.when, postTime(post.t, now));
  setText(p.title, post.title);
  setText(p.body, post.body ?? '');
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

// ---------- Composers ----------

function button(label, extra = '', attrs = {}) {
  return el('button', { class: `orch-btn${extra}`, type: 'button', text: label, ...attrs });
}

// The board composer at the foot of the Board panel. Built once, so a poll leaves
// the typed text and focus alone. A post shows at once at 60% opacity with
// data-pending. The 201 answer gives it the key a poll will use, and that poll
// replaces its content and removes data-pending. A refused post removes it and puts
// the typed text back.
function buildBoardComposer(root) {
  const title = el('input', { class: 'orch-field', maxlength: '120', placeholder: 'Post to the board', 'aria-label': 'Post title' });
  const body = el('textarea', { class: 'orch-field', rows: '3', maxlength: '2000', placeholder: 'Details', 'aria-label': 'Post details' });
  body.hidden = true;
  const toggle = el('button', { class: 'orch-link', type: 'button', text: 'Add details', 'aria-expanded': 'false' });
  const post = el('button', { class: 'orch-btn primary', type: 'submit', text: 'Post' });
  const error = el('p', { class: 'orch-error', role: 'alert' });
  error.hidden = true;
  const form = el('form', { class: 'orch-composer' }, [
    title,
    body,
    el('div', { class: 'row' }, [toggle, post]),
    error,
    el('span', { class: 'hint', text: 'The orchestrator reads the board while a wave runs.' }),
  ]);
  form.hidden = true;
  const showError = (text) => {
    error.textContent = text ?? '';
    error.hidden = !text;
  };
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? 'Add details' : 'Hide details';
    toggle.setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) body.focus();
  });
  let sequence = 0;
  let sending = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;
    const text = { title: title.value.trim(), body: body.value.trim() };
    if (!text.title) {
      showError(boardError(400, null));
      title.focus();
      return;
    }
    showError('');
    const id = root.dataset.id;
    const list = root._orch.boardList;
    const li = buildPost(text);
    li.dataset.key = `pending-${++sequence}`;
    li.setAttribute('data-pending', '');
    fillPost(li, { t: new Date().toISOString(), from: 'You', ...text }, Date.now());
    list.prepend(li);
    root._orch.boardEmpty.hidden = true;
    enter(li, { animate: true, opacity: 0.6 });
    const typed = { title: title.value, body: body.value };
    title.value = '';
    body.value = '';
    sending = true;
    post.setAttribute('aria-disabled', 'true');
    const result = await sendBoardPost(id, text);
    sending = false;
    post.removeAttribute('aria-disabled');
    if (result.ok && result.data?.t) {
      showError('');
      const key = `${result.data.t}You`;
      const same = [...list.children].find((child) => child !== li && child.dataset.key === key);
      if (same) li.remove();
      else li.dataset.key = key;
      body.hidden = true;
      toggle.textContent = 'Add details';
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    li.remove();
    if (!title.value) title.value = typed.title;
    if (!body.value) body.value = typed.body;
    showError(boardError(result.status, result.data));
    title.focus();
  });
  return { node: form };
}

// The steer status row and composer inside a worker card's .w-slot. getCard
// returns the card, which does not exist yet when this runs. The composer is
// built once and only shown or hidden, so a poll never rebuilds it.
function buildSteer(r, getCard) {
  const status = el('span', { class: 'steer-status', 'aria-live': 'polite', tabindex: '-1' });
  const open = button('Steer', '', { 'aria-expanded': 'false', 'aria-label': 'Steer' });
  const row = el('div', { class: 'w-steer-row' }, [status, open]);
  const input = el('textarea', { class: 'orch-field', rows: '2', maxlength: '2000' });
  const send = el('button', { class: 'orch-btn primary', type: 'submit', text: 'Send' });
  const cancel = button('Cancel');
  const error = el('p', { class: 'orch-error', role: 'alert' });
  error.hidden = true;
  const form = el('form', { class: 'steer-form' }, [
    input,
    el('div', { class: 'row' }, [
      el('span', { class: 'keys', text: '⌘Enter to send · Esc to cancel' }),
      el('span', { class: 'btns' }, [cancel, send]),
    ]),
    error,
  ]);
  form.hidden = true;
  const node = el('div', { class: 'w-slot' }, [row, form]);
  const s = { node, row, status, open, form, input, error };
  let sending = false;

  const showError = (text) => {
    error.textContent = text ?? '';
    error.hidden = !text;
  };
  const close = () => {
    form.hidden = true;
    input.value = '';
    showError('');
    open.hidden = !getCard()._worker?.canSteer || !getCard()._live;
    open.setAttribute('aria-expanded', 'false');
    // A hidden button cannot take focus, so the status row does.
    if (!open.hidden) open.focus();
    else if (!row.hidden) status.focus();
    else getCard()._r.head.focus();
  };
  open.addEventListener('click', () => {
    const card = getCard();
    input.setAttribute('aria-label', `Message to the ${card._worker ? `Task ${card._worker.task}` : 'task'} worker`);
    input.placeholder = input.getAttribute('aria-label');
    showError('');
    form.hidden = false;
    open.hidden = true;
    open.setAttribute('aria-expanded', 'true');
    fadeIn(form, { animate: true });
    input.focus();
  });
  cancel.addEventListener('click', close);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;
    const card = getCard();
    const text = input.value.trim();
    if (!text) {
      showError(steerError(400, null, text));
      input.focus();
      return;
    }
    showError('');
    sending = true;
    send.setAttribute('aria-disabled', 'true');
    const result = await sendSteer(r.root.dataset.id, { agentId: card.dataset.key, text });
    sending = false;
    send.removeAttribute('aria-disabled');
    if (!result.ok) {
      showError(steerError(result.status, result.data, text));
      input.focus();
      return;
    }
    card._sending = result.data?.id ?? true;
    close();
    updateSteer(card, card._worker, true);
  });
  return s;
}

// Shows the worker's lastSteer in the status row and the Steer button when the
// worker can be steered. After a send, the card says "Sending…" until a poll
// returns that request.
function updateSteer(card, w, animate) {
  const s = card._r.steer;
  if (card._sending && card._sending === w.lastSteer?.id) card._sending = null;
  const view = card._sending ? { word: 'Sending…', tone: 'plain' } : steerView(w.lastSteer);
  s.open.setAttribute('aria-label', `Steer Task ${w.task}`);
  swapText(s.status, view?.word ?? '', { animate });
  setClass(s.status, 'warn', view?.tone === 'warn');
  if (s.form.hidden) s.open.hidden = !w.canSteer || !card._live;
  s.row.hidden = !view && s.open.hidden;
}
