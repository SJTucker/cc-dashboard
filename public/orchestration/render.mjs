// Draws the Orchestration tab: the switcher across the top, then the selected
// orchestration's orchestrator panel, workers, actions feed and board. Both render
// functions update existing nodes by data-key and create or remove only what
// changed, so a poll that changes one worker leaves the rest of the page alone.
// Nothing here touches the DOM at import time.
import { el } from '../dom.mjs';
import { formatDuration } from '../format.mjs';
import { enter, fadeIn, flashText, swapText } from './motion.mjs';
import {
  CONTEXT_BUDGET, CONTEXT_WARN, STEER_DRAIN_MS, attentionItems, boardError, clock, contextView, filesView, foldFeed, nowView, postTime,
  reviewHistory, reviewLabel, runCard, statusView, stepLabel, steerError, steerMeta, steerState, taskLabel, tookLabel, unseenPosts, waveSpans,
} from './view.mjs';

// `Task 3 (Fix the regex)`, or `Task 3` when the worker has no title.
const taskWithTitle = (w) => (typeof w.title === 'string' && w.title ? `Task ${w.task} (${w.title})` : `Task ${w.task}`);

// Brings the keyed children of parent in line with items: creates missing ones,
// updates all, orders them as items are, removes the rest. A repeated key gets a
// numeric suffix. Returns the nodes it created.
function reconcile(parent, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of parent.children) existing.set(child.dataset.key, child);
  const keys = [];
  const used = new Set();
  for (const item of items) {
    const base = keyOf(item);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}#${n}`;
    used.add(key);
    keys.push(key);
  }
  // Stale children go first, so the ordering loop never finds one as `wanted` and
  // moves a connected node (a move blurs a focused textarea and restarts animations).
  // A board post the owner just sent has no entry in items until a poll reads it.
  for (const [key, child] of existing) if (!used.has(key) && !child.hasAttribute('data-pending')) child.remove();
  const created = [];
  let previous = null;
  for (const [i, item] of items.entries()) {
    const key = keys[i];
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
      const pill = el('span', { class: 'run-pill' });
      const meta = el('span', { class: 'run-meta' });
      const pips = el('span', { class: 'run-pips', 'aria-hidden': 'true' });
      const labels = el('span', { class: 'run-pip-labels', 'aria-hidden': 'true' });
      for (let i = 0; i < 4; i++) {
        pips.appendChild(el('span', { class: 'pip' }));
        labels.appendChild(el('span'));
      }
      const counts = el('span', { class: 'run-counts' });
      const cnts = [];
      for (let i = 0; i < 4; i++) {
        const glyph = el('span', { class: 'cnt-glyph' });
        const word = el('span', { class: 'cnt-word' });
        const n = el('b');
        const cnt = el('span', { class: 'cnt' }, [glyph, document.createTextNode(' '), word, document.createTextNode(' '), n]);
        counts.appendChild(cnt);
        cnts.push({ cnt, glyph, word, n });
      }
      const card = el('button', { class: 'run', type: 'button' }, [
        el('span', { class: 'run-top' }, [name, pill]),
        meta,
        el('span', { class: 'run-phase' }, [pips, labels]),
        counts,
      ]);
      card._r = { name, pill, meta, pips, labels, cnts };
      card.addEventListener('click', () => onSelect(card.dataset.key));
      return card;
    },
    (card, s) => {
      const r = card._r;
      const view = runCard(s, now);
      setText(r.name, s.topic ?? '');
      setText(r.pill, `${view.pill.glyph} ${view.pill.text}`);
      r.pill.className = `run-pill ${view.pill.tone}`;
      setText(r.meta, view.meta.join(' · '));
      view.pips.forEach((pip, i) => {
        r.pips.children[i].className = `pip ${pip.state}${pip.wait ? ' wait' : ''}`;
        setText(r.labels.children[i], pip.name);
      });
      view.counts.forEach((c, i) => {
        const cell = r.cnts[i];
        cell.cnt.className = `cnt ${c.tone === 'plain' ? '' : c.tone}`.trim();
        setText(cell.glyph, c.glyph);
        setText(cell.word, c.word);
        flashText(cell.n, String(c.n), { animate: true });
      });
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
  const banner = el('div', { class: 'orch-banner', 'aria-live': 'polite' });

  const nowGlyph = el('span', { class: 'g', 'aria-hidden': 'true' });
  const nowText = el('span', { class: 'tx' });
  const nowSince = el('span', { class: 'since' });
  const nowLine = el('div', { class: 'now-line' }, [nowGlyph, nowText, nowSince]);
  const quiet = el('div', { class: 'quiet-line', text: '✓ Nothing needs you right now.' });
  const strip = el('div', { class: 'wave-strip' });
  const status = el('div', { class: 'orch-status' }, [nowLine, quiet, strip]);

  const waves = el('div', { class: 'orch-waves' });
  const wavesEmpty = el('p', { class: 'orch-empty', text: 'Workers show here once the orchestrator starts a wave.' });
  const workers = panel('waves orch-waves-panel', 'Workers', [waves, wavesEmpty]);

  const feed = el('ul', { class: 'feed' });
  const actions = panel('orch-feed-panel', 'Orchestrator actions', [el('div', { class: 'feed-wrap' }, [feed])]);

  const boardList = el('ul', { class: 'board-list' });
  const postButton = button('Post a note', '', { 'aria-expanded': 'false' });
  const boardMeta = el('span', { class: 'panel-meta' });
  const board = el('section', { class: 'panel board orch-board' }, [
    el('div', { class: 'panel-head' }, [el('h2', { text: 'Board' }), boardMeta, postButton]),
    boardList,
  ]);
  const composer = buildBoardComposer(root, postButton);
  board.appendChild(composer.node);

  const cols = el('div', { class: 'orch-cols' }, [
    el('div', { class: 'orch-left' }, [workers.node]),
    el('div', { class: 'orch-right' }, [board, actions.node]),
  ]);
  root.replaceChildren(banner, status, cols);
  root.dataset.id = id;
  root._orch = {
    open: new Set(),
    banner, nowLine, nowGlyph, nowText, nowSince, quiet, strip,
    workersMeta: workers.meta, waves, wavesEmpty,
    feed, feedMeta: actions.meta, board, boardMeta, boardList, postButton, composer,
    root,
  };
  return root._orch;
}

// Draws one orchestration's Detail. firstRender is true on the first render after
// a selection change, and nothing animates then. seenBoard is how many board posts
// the viewer has already seen. actions is { sendBoardPost, sendSteer }, the calls the
// composers make, so this module does no network I/O of its own.
export function renderDetail(root, detail, { seenBoard = 0, firstRender = false, now = Date.now(), actions } = {}) {
  if (!actions?.sendBoardPost || !actions?.sendSteer) throw new Error('renderDetail needs actions.sendBoardPost and actions.sendSteer');
  const fresh = root.dataset.id !== detail.id;
  const r = fresh ? buildSkeleton(root, detail.id) : root._orch;
  r.actions = actions;
  const animate = !(firstRender || fresh);

  r.live = detail.live;
  const items = renderBanner(r, detail, animate);
  renderStatus(r, detail, items.length > 0, animate, now);
  renderWaves(r, detail, animate, now);
  renderFeed(r, detail.feed);
  renderBoard(r, detail, seenBoard, animate, now);
  r.postButton.hidden = !detail.live;
  r.composer.sync(detail.live);
}

// ---------- Attention banner and status block ----------

// Opens the steer form of the worker with this agent id: scrolls its card into view
// and presses the card's own Steer button. An open form takes focus instead.
function openSteer(r, agentId) {
  const card = [...r.waves.querySelectorAll('.worker')].find((c) => c._agentId === agentId);
  if (!card?._r.steer) return;
  if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center' });
  const { form, input, open } = card._r.steer;
  if (!form.hidden) input.focus();
  else if (!open.hidden) open.click();
}

function buildBanner(r, item) {
  const mark = el('span', { class: 'big', 'aria-hidden': 'true' });
  const heading = el('h3');
  const how = el('p', { class: 'how' });
  const quote = el('blockquote');
  const meta = el('p', { class: 'meta' });
  const act = button('', '');
  const node = el('div', { class: `banner ${item.kind}` }, [
    mark,
    el('div', { class: 'body' }, [heading, how, quote, meta]),
    el('div', { class: 'acts' }, [act]),
  ]);
  node._r = { mark, heading, how, quote, meta, act, text: '' };
  if (item.kind === 'waiting') {
    act.textContent = 'Copy question';
    act.addEventListener('click', async () => {
      const result = await Promise.resolve().then(() => navigator.clipboard.writeText(node._r.text)).then(() => 'Copied', () => 'Copy failed');
      act.textContent = result;
      const timer = setTimeout(() => { act.textContent = 'Copy question'; }, 1200);
      timer?.unref?.();
    });
  } else {
    act.addEventListener('click', () => openSteer(r, node.dataset.key.slice('stuck:'.length)));
  }
  return node;
}

function updateBanner(node, item, r) {
  const b = node._r;
  if (item.kind === 'waiting') {
    setText(b.mark, '?');
    setText(b.heading, 'The orchestrator is waiting for you');
    setText(b.how, "Answer in the orchestrator's terminal session. The dashboard cannot send the reply.");
    b.text = item.text;
    setText(b.quote, item.text);
    b.quote.hidden = !item.text;
    setText(b.meta, item.since ? `Last orchestrator message · asked ${clock(item.since)}` : 'Last orchestrator message');
    return;
  }
  const w = item.worker;
  setText(b.mark, '!');
  setText(b.heading, `${w.task == null ? 'A worker' : `Task ${w.task}`} is stuck · ${item.event.type}`);
  setText(b.how, `${item.event.text} Steer it back on track.`);
  b.quote.hidden = true;
  const meta = steerMeta(w.lastSteer);
  setText(b.meta, meta);
  b.meta.hidden = !meta;
  b.act.textContent = w.task == null ? 'Steer this worker' : `Steer Task ${w.task}`;
  b.act.hidden = !(w.canSteer && r.live);
}

function renderBanner(r, detail, animate) {
  const items = attentionItems(detail);
  const created = reconcile(
    r.banner,
    items,
    (item) => (item.kind === 'waiting' ? 'waiting' : `stuck:${item.worker.agentId}`),
    (item) => buildBanner(r, item),
    (node, item) => updateBanner(node, item, r),
  );
  for (const node of created) enter(node, { animate });
  return items;
}

function renderStatus(r, detail, hasBanner, animate, now) {
  const view = nowView(detail);
  r.nowLine.className = `now-line ${view.tone}`;
  setText(r.nowGlyph, view.glyph);
  swapText(r.nowText, view.text, { animate });
  setText(r.nowSince, view.since);
  r.quiet.hidden = hasBanner;

  const spans = waveSpans(detail.waves ?? [], { live: Boolean(detail.live), now });
  r.strip.hidden = spans.length === 0;
  reconcile(
    r.strip,
    spans,
    (s) => `w${s.n}`,
    () => {
      const name = el('b');
      const dur = el('span');
      const seg = el('div', { class: 'seg' }, [name, document.createTextNode(' '), dur]);
      seg._r = { name, dur };
      return seg;
    },
    (seg, s) => {
      setText(seg._r.name, `W${s.n}`);
      setText(seg._r.dur, s.ms == null ? '—' : s.running ? `${formatDuration(s.ms)} so far` : formatDuration(s.ms));
      setClass(seg, 'live', s.running);
      // The segment's length follows the wave's, with a floor set in CSS.
      seg.style.flexGrow = String(s.ms == null ? 0 : Math.max(1, Math.round(s.ms / 1000)));
    },
  );
}

// ---------- Workers ----------

// The card statuses: a worker that has not yet reported done or been merged is live. A worker that
// finished its own work but is not merged keeps the card, with a review row in place of the tool row.
const FINISHED = new Set(['done', 'review', 'passed', 'changes']);

const spanText = (cls, text = '') => el('span', { class: cls, text });

function renderWaves(r, detail, animate, now) {
  const waves = (detail.waves ?? []).map((wave) => ({ ...wave, workers: wave.workers ?? [] }));
  const spans = waveSpans(waves, { live: Boolean(detail.live), now });
  const last = waves.at(-1);
  const sections = [];
  if (last) sections.push({ kind: 'live', wave: last, span: spans.at(-1) });
  if (waves.length > 1) sections.push({ kind: 'label' });
  // Earlier waves list newest first, each with the span computed for its own wave.
  for (let i = waves.length - 2; i >= 0; i--) sections.push({ kind: 'past', wave: waves[i], span: spans[i] });

  r.wavesEmpty.hidden = waves.length > 0;
  setText(r.workersMeta, last ? `Wave ${last.n} · ${last.workers.length} ${last.workers.length === 1 ? 'task' : 'tasks'}` : 'no wave started');

  reconcile(
    r.waves,
    sections,
    (s) => (s.kind === 'label' ? 'earlier' : `${s.kind}-${s.wave.n}`),
    buildSection,
    (node, s) => updateSection(node, s, r, animate, now),
  );
}

function buildSection({ kind }) {
  if (kind === 'label') return el('div', { class: 'wlabel' }, [el('span', { class: 'label', text: 'EARLIER WAVES' })]);
  if (kind === 'past') {
    const wn = el('span', { class: 'wn' });
    const tt = el('span', { class: 'tt' });
    const du = el('span', { class: 'du' });
    const node = el('div', { class: 'past-wave' }, [wn, tt, du]);
    node._r = { wn, tt, du };
    return node;
  }
  const label = el('span', { class: 'label live-label' });
  const meta = el('span', { class: 'since' });
  const body = el('div', { class: 'orch-workers' });
  const node = el('div', { class: 'wave' }, [el('div', { class: 'wlabel' }, [label, meta]), body]);
  node._r = { label, meta, body };
  return node;
}

function updateSection(node, s, r, animate, now) {
  if (s.kind === 'label') return;
  const w = node._r;
  const { wave, span } = s;
  if (s.kind === 'past') {
    setText(w.wn, `Wave ${wave.n}`);
    reconcile(
      w.tt,
      wave.workers,
      (worker) => worker.agentId,
      () => el('div', { class: 'tl' }, [spanText('g'), spanText('tx')]),
      (line, worker) => {
        setText(line.children[0], statusView(worker.status).glyph);
        setText(line.children[1], [taskLabel(worker), worker.title ?? ''].filter(Boolean).join(' '));
      },
    );
    setText(w.du, `started ${wave.startedAt ? clock(wave.startedAt) : '—'} · took ${span.ms == null ? '—' : formatDuration(span.ms)}`);
    return;
  }
  setText(w.label, `WAVE ${wave.n}`);
  const length = span.ms == null ? '' : span.running ? ` · ${formatDuration(span.ms)} so far` : ` · took ${formatDuration(span.ms)}`;
  setText(w.meta, wave.startedAt ? `started ${clock(wave.startedAt)}${length}` : '');
  reconcile(
    w.body,
    wave.workers,
    (worker) => `${worker.agentId}:${worker.status === 'merged' ? 'fin' : 'card'}`,
    (worker) => (worker.status === 'merged' ? buildFin(r) : buildWorker(r)),
    (card, worker) => (worker.status === 'merged' ? updateFin(card, worker, r) : updateWorker(card, worker, r, animate, now)),
  );
}

function chevron(label) {
  return el('button', { class: 'chev', type: 'button', 'aria-expanded': 'false', 'aria-label': label }, [el('span', { class: 'chev-i', text: '›', 'aria-hidden': 'true' })]);
}

// Wires a chevron to a card's .w-more. The open state lives in r.open by agent id, so a
// card rebuilt as another kind of row keeps it.
function wireChevron(r, card, chev, more, fill) {
  chev.addEventListener('click', () => {
    const id = card._agentId;
    const open = !r.open.has(id);
    if (open) r.open.add(id);
    else r.open.delete(id);
    chev.setAttribute('aria-expanded', String(open));
    more.hidden = !open;
    if (open) {
      fill(card._worker, Date.now());
      fadeIn(more, { animate: true });
    }
  });
}

function badge() {
  const glyph = el('span', { class: 'gl', 'aria-hidden': 'true' });
  const word = el('span');
  return { node: el('span', { class: 'badge' }, [glyph, word]), glyph, word };
}

function detSection(title) {
  const body = el('div');
  return { head: el('h4', { class: 'label', text: title }), body };
}

function fileList(list, items) {
  reconcile(
    list,
    items,
    (f) => `${f.mark}:${f.path}`,
    () => el('li', {}, [spanText('g'), spanText('p')]),
    (li, f) => {
      setText(li.children[0], f.mark);
      setText(li.children[1], f.note ? `${f.path} ${f.note}` : f.path);
      setClass(li, 't', f.mark === '●');
      setClass(li, 'x', f.mark === '!');
    },
  );
}

// A worker card. Every node below is built once and updated in place on each poll,
// so a text selection or an open composer survives it.
function buildWorker(r) {
  const b = badge();
  const c = {
    badgeGlyph: b.glyph, badgeWord: b.word,
    tid: el('span', { class: 'tid' }),
    titleText: el('span', { class: 'w-title' }),
    meta: el('span', { class: 'w-meta' }),
    causeKind: el('span', { class: 'k' }),
    causeText: el('span', { class: 't' }),
    causeAt: el('span', { class: 'at' }),
    tool: el('span', { class: 'tool' }),
    code: el('code'),
    review: el('div', { class: 'review' }),
    filesValue: el('span', { class: 'v' }),
    cells: el('div', { class: 'files' }),
    ctxValue: el('span', { class: 'v ctx-val' }),
    ctxLeft: el('span', { class: 'r ctx-left' }),
    zone: el('span', { class: 'zone' }),
    fill: el('span', { class: 'fill' }),
    tick: el('span', { class: 'tick' }),
    doneWhen: el('p'),
    plannedList: el('ul', { class: 'pf' }),
    moreList: el('ul', { class: 'steps' }),
  };
  const steer = buildSteer(r, () => card);
  const chev = chevron('Show details');
  const head = el('div', { class: 'w-head' }, [b.node, c.tid, c.titleText, c.meta, el('span', { class: 'acts' }, [steer.open, chev])]);
  const cause = el('div', { class: 'cause' }, [c.causeKind, c.causeText, c.causeAt]);
  cause.hidden = true;
  const toolRow = el('div', { class: 'w-tool' }, [c.tool, c.code]);
  const meters = el('div', { class: 'meters' }, [
    el('div', { class: 'm' }, [el('div', { class: 'ml' }, [el('span', { class: 'label', text: 'Files' }), c.filesValue]), c.cells]),
    el('div', { class: 'm' }, [
      el('div', { class: 'ml' }, [el('span', { class: 'label', text: 'Context' }), c.ctxValue, c.ctxLeft]),
      el('div', { class: 'ctx-meter' }, [c.zone, c.fill, c.tick, el('span', { class: 'tkl', text: '150k' })]),
    ]),
  ]);
  const left = detSection('Done when');
  const planned = detSection('Planned files');
  const steps = detSection('Last steps');
  const more = el('div', { class: 'w-more' }, [
    el('div', { class: 'det' }, [
      el('div', {}, [left.head, c.doneWhen, planned.head, c.plannedList]),
      el('div', {}, [steps.head, c.moreList]),
    ]),
  ]);
  more.hidden = true;
  const card = el('div', { class: 'worker' }, [head, cause, toolRow, c.review, meters, steer.row, steer.node, more]);
  Object.assign(c, { head, cause, toolRow, more, chev, steer });
  card._r = c;
  wireChevron(r, card, chev, more, (w, now) => fillMore(c, w, now));
  return card;
}

function updateWorker(card, w, r, animate, now) {
  const c = card._r;
  card._worker = w;
  card._live = r.live;
  card._agentId = w.agentId;
  card.dataset.s = w.status;
  const view = statusView(w.status);
  const finished = FINISHED.has(w.status);
  setText(c.badgeGlyph, view.glyph);
  setText(c.badgeWord, view.word);
  setText(c.tid, taskLabel(w));
  setText(c.titleText, w.title ?? '');

  if (finished) setText(c.meta, `worked ${tookLabel(w.startedAt, w.lastActiveAt)}`);
  else setText(c.meta, `run ${tookLabel(w.startedAt, new Date(now).toISOString())} · review none yet`);

  const event = w.status === 'stuck' ? attentionItems({ waves: [{ workers: [w] }] })[0]?.event : null;
  c.cause.hidden = !event;
  if (event) {
    setText(c.causeKind, event.type);
    setText(c.causeText, event.text);
    setText(c.causeAt, event.at ? clock(event.at) : '');
  }

  c.toolRow.hidden = finished;
  c.review.hidden = !finished;
  if (finished) setText(c.review, w.review ? reviewLabel(w.review, now) : 'Review none yet');
  else {
    c.tool.hidden = !w.current;
    setText(c.tool, w.current?.tool ?? '');
    setText(c.code, w.current ? String(w.current.text ?? '') : 'No tool call yet');
  }

  const files = filesView(w);
  const touchedCount = files.cells.filter((cell) => cell.touched).length;
  setText(c.filesValue, files.cells.length === 0
    ? 'No planned files'
    : `${touchedCount} of ${files.cells.length} planned${files.outside.length ? ` · ${files.outside.length} outside plan` : ''}`);
  reconcile(
    c.cells,
    files.cells,
    (cell) => cell.path,
    () => el('i', { class: 'cell' }),
    (cell, item) => {
      setClass(cell, 'touched', item.touched);
      cell.setAttribute('title', item.path);
    },
  );

  const ctx = contextView(w.contextTokens);
  const budget = `${CONTEXT_BUDGET / 1000}k`;
  flashText(c.ctxValue, w.contextTokens == null ? '—' : `${ctx.warn ? '! ' : ''}${ctx.value} of ${budget}`, { animate });
  setText(c.ctxLeft, ctx.left);
  setClass(c.ctxValue, 'warn', ctx.warn);
  setClass(c.ctxLeft, 'warn', ctx.warn);
  c.fill.style.clipPath = `inset(0 ${Math.round((1 - ctx.ratio) * 1000) / 10}% 0 0)`;
  c.zone.style.left = `${(CONTEXT_WARN / CONTEXT_BUDGET) * 100}%`;
  c.tick.style.left = `${(CONTEXT_WARN / CONTEXT_BUDGET) * 100}%`;

  updateSteer(card, w, animate, now);
  const open = r.open.has(w.agentId);
  c.chev.setAttribute('aria-expanded', String(open));
  c.more.hidden = !open;
  if (open) fillMore(c, w, now);
}

function fillMore(c, w, now) {
  const steps = [...(w.steps ?? [])].reverse();
  reconcile(
    c.moreList,
    steps,
    (step) => String(step.line),
    () => el('li', {}, [spanText('tm'), spanText('kd'), spanText('tx')]),
    (li, step) => {
      setText(li.children[0], step.time ? clock(step.time) : '');
      setText(li.children[1], step.kind === 'error' ? 'err' : step.kind ?? '');
      setClass(li.children[1], 'error', step.kind === 'error');
      setText(li.children[2], step.tool ? `${step.tool}: ${step.text ?? ''}` : stepLabel(step));
    },
  );
  const files = filesView(w);
  fileList(c.plannedList, [
    ...files.cells.map((cell) => ({ mark: cell.touched ? '●' : '○', path: cell.path })),
    ...files.outside.map((path) => ({ mark: '!', path, note: '(outside plan)' })),
  ]);
  setText(c.doneWhen, w.doneWhen ?? 'not stated');
}

// A merged worker: one row, with its review history and, when opened, its report and files.
function buildFin(r) {
  const b = badge();
  setText(b.glyph, '✓');
  setText(b.word, 'Merged');
  const c = {
    tid: el('span', { class: 'tid' }),
    titleText: el('span', { class: 'w-title' }),
    meta: el('span', { class: 'w-meta' }),
    reviewSpan: el('span'),
    filesSpan: el('span'),
    report: el('p'),
    fileList: el('ul', { class: 'pf' }),
  };
  const chev = chevron('Show summary');
  const head = el('div', { class: 'w-head' }, [b.node, c.tid, c.titleText, c.meta, el('span', { class: 'acts' }, [chev])]);
  const report = detSection('Final report');
  const files = detSection('Files');
  const more = el('div', { class: 'w-more' }, [
    el('div', { class: 'det' }, [el('div', {}, [report.head, c.report]), el('div', {}, [files.head, c.fileList])]),
  ]);
  more.hidden = true;
  const card = el('div', { class: 'worker fin' }, [head, el('div', { class: 'sum' }, [c.reviewSpan, c.filesSpan]), more]);
  Object.assign(c, { chev, more });
  card._r = c;
  card.dataset.s = 'merged';
  wireChevron(r, card, chev, more, (w) => fillFin(c, w));
  return card;
}

function fillFin(c, w) {
  setText(c.report, w.report || 'No report recorded.');
  fileList(c.fileList, (w.files ?? []).map((path) => ({ mark: '●', path })));
}

function updateFin(card, w, r) {
  const c = card._r;
  card._worker = w;
  card._live = r.live;
  card._agentId = w.agentId;
  setText(c.tid, taskLabel(w));
  setText(c.titleText, w.title ?? '');
  setText(c.meta, w.mergedAt ? `at ${clock(w.mergedAt)} · took ${tookLabel(w.startedAt, w.mergedAt)}` : 'merged');
  setText(c.reviewSpan, `Review ${reviewHistory(w.reviews)}`);
  const n = (w.files ?? []).length;
  setText(c.filesSpan, `${n} ${n === 1 ? 'file' : 'files'}`);
  const open = r.open.has(w.agentId);
  c.chev.setAttribute('aria-expanded', String(open));
  c.more.hidden = !open;
  if (open) fillFin(c, w);
}


// ---------- Feed and board ----------

function buildFeedEntry() {
  return el('li', {}, [el('span', { class: 't' }), el('span', { class: 'g' }), el('span', { class: 'x' }, [el('span', { class: 'what' }), el('span', { class: 'detail' })])]);
}

function fillFeedEntry(li, f) {
  const [t, g, x] = li.children;
  setText(t, clock(f.at));
  setText(g, f.glyph);
  setText(x.children[0], f.text);
  x.children[1].hidden = !f.detail;
  setText(x.children[1], f.detail ? ` · ${f.detail}` : '');
  setClass(li, 'merge', f.glyph === '✓');
  setClass(li, 'you', f.glyph === '↗');
}

// A folded run of routine entries: a button that opens and closes the list under it.
// The node is built once and keyed by its oldest entry, so its open state survives a poll.
function buildFeedGroup() {
  const label = el('span', { class: 'tx' });
  const toggle = el('button', { class: 'grp', type: 'button', 'aria-expanded': 'false' }, [el('span', { class: 'tm' }), el('span', { class: 'gl', text: '▸' }), label]);
  const list = el('ul', { class: 'sub-list' });
  const sub = el('div', { class: 'sub-items' }, [el('div', {}, [list])]);
  const li = el('li', { class: 'feed-group' }, [toggle, sub]);
  li._r = { toggle, label, list, sub };
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    setClass(sub, 'open', open);
    setText(toggle.children[1], open ? '▾' : '▸');
  });
  return li;
}

function renderFeed(r, feed) {
  const items = foldFeed(feed);
  reconcile(
    r.feed,
    items,
    (item) => item.key,
    (item) => (item.kind === 'group' ? buildFeedGroup() : buildFeedEntry()),
    (li, item) => {
      if (item.kind === 'entry') {
        fillFeedEntry(li, item.entry);
        return;
      }
      const g = li._r;
      setText(g.label, item.label);
      reconcile(g.list, item.entries, (f) => `${f.at}|${f.line}`, buildFeedEntry, fillFeedEntry);
    },
  );
  const routine = (feed ?? []).filter((f) => f.glyph === '·').length;
  setText(r.feedMeta, `${(feed ?? []).length - routine} key · ${routine} routine folded`);
}

function renderBoard(r, detail, seenBoard, animate, now) {
  const board = detail.board ?? [];
  const fresh = unseenPosts(board, seenBoard);
  const unseen = fresh.size;
  adoptPending(r.boardList, board);
  const created = reconcile(
    r.boardList,
    board.map((post) => ({ post, isNew: fresh.has(post) })),
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
  drawBoardMeta(r, unseen);
}

// "No notes yet" with an empty list, else the post count and how many are new.
function drawBoardMeta(r, unseen = 0) {
  const count = r.boardList.children.length;
  setText(r.boardMeta, count === 0 ? 'No notes yet' : `${count} ${count === 1 ? 'post' : 'posts'}${unseen ? ` · ${unseen} new` : ''}`);
  setClass(r.board, 'empty', count === 0);
}

// A poll can land between the server writing the owner's post and the 201 answer.
// A listed post from You with the same title and a time within 10 s of the request
// takes over the pending node, so no solid copy appears beside it.
const ADOPT_WINDOW_MS = 10_000;
function adoptPending(list, board) {
  const taken = new Set([...list.children].map((child) => child.dataset.key));
  for (const li of list.querySelectorAll(':scope > [data-pending]')) {
    const post = board.find((p) => p.from === 'You'
      && p.title === li._r.title.textContent
      && Math.abs(new Date(p.t).getTime() - li._sentAt) <= ADOPT_WINDOW_MS
      && !taken.has(`${p.t}You`));
    if (!post) continue;
    li.dataset.key = `${post.t}You`;
    taken.add(li.dataset.key);
  }
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
function buildBoardComposer(root, openButton) {
  const title = el('input', { class: 'orch-field', maxlength: '120', placeholder: 'Post to the board', 'aria-label': 'Post title' });
  const body = el('textarea', { class: 'orch-field', rows: '3', maxlength: '2000', placeholder: 'Details', 'aria-label': 'Post details' });
  body.hidden = true;
  const toggle = el('button', { class: 'orch-link', type: 'button', text: 'Add details', 'aria-expanded': 'false' });
  const post = el('button', { class: 'orch-btn primary', type: 'submit', text: 'Post' });
  const cancel = button('Cancel');
  const error = el('p', { class: 'orch-error', role: 'alert' });
  error.hidden = true;
  const form = el('form', { class: 'orch-composer' }, [
    title,
    body,
    el('div', { class: 'row' }, [toggle, el('span', { class: 'btns' }, [cancel, post])]),
    error,
    el('span', { class: 'hint', text: 'The orchestrator reads the board while a wave runs.' }),
  ]);
  form.hidden = true;
  const showError = (text) => {
    error.textContent = text ?? '';
    error.hidden = !text;
  };
  // The form stays hidden until Post a note opens it. Cancel and Esc hide it and keep
  // what was typed. A board that is not live hides it whatever the state.
  const state = { open: false, live: true };
  const sync = () => { form.hidden = !(state.open && state.live); };
  const show = () => {
    state.open = true;
    sync();
    openButton.setAttribute('aria-expanded', 'true');
    title.focus();
  };
  const hide = () => {
    state.open = false;
    sync();
    openButton.setAttribute('aria-expanded', 'false');
    openButton.focus();
  };
  openButton.addEventListener('click', () => (state.open ? hide() : show()));
  cancel.addEventListener('click', hide);
  for (const field of [title, body]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    });
  }
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
      showError(boardError(400, null, text.title));
      title.focus();
      return;
    }
    showError('');
    const id = root.dataset.id;
    const list = root._orch.boardList;
    const li = buildPost(text);
    li.dataset.key = `pending-${++sequence}`;
    li.setAttribute('data-pending', '');
    li._sentAt = Date.now();
    fillPost(li, { t: new Date().toISOString(), from: 'You', ...text }, Date.now());
    list.prepend(li);
    drawBoardMeta(root._orch);
    enter(li, { animate: true, opacity: 0.6 });
    const typed = { title: title.value, body: body.value };
    title.value = '';
    body.value = '';
    sending = true;
    post.setAttribute('aria-disabled', 'true');
    const result = await root._orch.actions.sendBoardPost(id, text);
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
      hide();
      return;
    }
    li.remove();
    drawBoardMeta(root._orch);
    if (!title.value) title.value = typed.title;
    if (!body.value) body.value = typed.body;
    showError(boardError(result.status, result.data, text.title));
    title.focus();
  });
  return { node: form, sync: (live) => { state.live = Boolean(live); sync(); } };
}

// The steer composer of a worker card, and its open button. getCard returns the card,
// which does not exist yet when this runs. The composer is built once and only shown or
// hidden, so a poll never rebuilds it. node is .w-compose: its class "open" grows it
// from 0fr to 1fr, and form.hidden stays the state that tests and openSteer read. row is
// the .w-steer status row, which updateSteer fills.
function buildSteer(r, getCard) {
  const open = button('Steer', '', { 'aria-expanded': 'false', 'aria-label': 'Steer' });
  const input = el('textarea', { class: 'orch-field', rows: '3', maxlength: '2000' });
  const count = el('span', { class: 'cn', text: '0 / 2000' });
  const send = el('button', { class: 'orch-btn primary', type: 'submit', text: 'Send' });
  send.setAttribute('disabled', '');
  const cancel = button('Cancel');
  const error = el('p', { class: 'orch-error', role: 'alert' });
  error.hidden = true;
  const form = el('form', { class: 'steer-form' }, [
    input,
    el('div', { class: 'row' }, [
      count,
      el('span', { class: 'keys', text: '⌘↵ to send · Esc to cancel' }),
      el('span', { class: 'btns' }, [cancel, send]),
    ]),
    error,
  ]);
  form.hidden = true;
  const node = el('div', { class: 'w-compose' }, [el('div', { class: 'w-compose-in' }, [form])]);

  const stGlyph = el('span', { class: 'gl', 'aria-hidden': 'true' });
  const stWord = el('span', { class: 'sw' });
  const stState = el('span', { class: 'state' }, [stGlyph, document.createTextNode(' '), stWord]);
  const qt = el('span', { class: 'qt' });
  const when = el('small', { class: 'when' });
  const sub = el('small', { class: 'sub' });
  const again = button('Steer again');
  again.hidden = true;
  const row = el('div', { class: 'w-steer', tabindex: '-1', 'aria-live': 'polite' }, [stState, el('p', { class: 'q' }, [qt, when, sub]), again]);
  row.hidden = true;
  const s = { node, row, open, form, input, error, send, count, again, stState, stGlyph, stWord, qt, when, sub, drain: null, drainFor: null, text: '' };
  let sending = false;

  const showError = (text) => {
    error.textContent = text ?? '';
    error.hidden = !text;
  };
  const syncCount = () => {
    const n = input.value.length;
    setText(count, `${n} / 2000`);
    setClass(count, 'warn', n > 1800);
    if (input.value.trim()) send.removeAttribute('disabled');
    else send.setAttribute('disabled', '');
  };
  const close = () => {
    form.hidden = true;
    node.classList.remove('open');
    input.value = '';
    syncCount();
    showError('');
    open.hidden = !getCard()._worker?.canSteer || !getCard()._live || FINISHED.has(getCard()._worker?.status);
    open.setAttribute('aria-expanded', 'false');
    // A hidden button cannot take focus, so the status row does.
    if (!open.hidden) open.focus();
    else if (!row.hidden) row.focus();
    else getCard()._r.chev.focus();
  };
  const openForm = (text) => {
    const card = getCard();
    input.setAttribute('aria-label', `Message to the ${card._worker?.task != null ? taskWithTitle(card._worker) : 'task'} worker`);
    input.placeholder = input.getAttribute('aria-label');
    showError('');
    card._sendError = null;
    if (text != null) input.value = text;
    syncCount();
    form.hidden = false;
    node.classList.add('open');
    open.hidden = true;
    open.setAttribute('aria-expanded', 'true');
    updateSteer(card, card._worker, true);
    input.focus();
  };
  open.addEventListener('click', () => openForm());
  again.addEventListener('click', () => (form.hidden ? openForm(s.text) : input.focus()));
  cancel.addEventListener('click', close);
  input.addEventListener('input', syncCount);
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
    card._sendError = null;
    card._sendText = text;
    card._sendAt = new Date().toISOString();
    sending = true;
    send.setAttribute('aria-disabled', 'true');
    const result = await r.actions.sendSteer(r.root.dataset.id, { agentId: card._agentId, text });
    sending = false;
    send.removeAttribute('aria-disabled');
    if (!result.ok) {
      const message = steerError(result.status, result.data, text);
      if (form.hidden) {
        // Esc closed the form during the request, so the error goes in the status row.
        card._sendError = { word: message, tone: 'warn', forId: card._worker?.lastSteer?.id };
        updateSteer(card, card._worker, true);
        return;
      }
      showError(message);
      input.focus();
      return;
    }
    card._sending = result.data?.id ?? true;
    close();
    updateSteer(card, card._worker, true);
  });
  return s;
}

// Fills the card's steer row from its lastSteer, and shows the Steer button when the worker
// can be steered. After a send, the row reads Pending and Sending… until a poll returns
// that request. The drain line is one node per request: a poll leaves it alone, and it is
// removed when the 30 s are used or the steer leaves pending.
function updateSteer(card, w, animate, now = Date.now()) {
  const s = card._r.steer;
  if (card._sending && card._sending === w.lastSteer?.id) card._sending = null;
  // A late send error ends when the worker has a newer steer or can no longer be steered.
  if (card._sendError && (card._sendError.forId !== w.lastSteer?.id || !w.canSteer)) card._sendError = null;
  const last = w.lastSteer;
  const st = steerState(last, now);
  const can = Boolean(w.canSteer && card._live && !FINISHED.has(w.status));
  let view = null;
  if (card._sending) view = { glyph: '◌', word: 'Pending', sub: 'Sending…', text: card._sendText ?? '', at: card._sendAt, st: 'pending' };
  else if (card._sendError) view = { glyph: '✕', word: 'Failed', sub: card._sendError.word, warn: true, text: card._sendText ?? '', at: card._sendAt, st: 'failed', again: true };
  else if (st) view = { glyph: st.glyph, word: st.word, sub: st.sub, text: last.text ?? '', at: last.at, st: last.state, again: st.again };

  s.open.setAttribute('aria-label', w.task == null ? 'Steer this worker' : `Steer ${taskWithTitle(w)}`);
  if (s.form.hidden) s.open.hidden = !can;
  s.row.hidden = !view;
  s.row.setAttribute('data-st', view?.st ?? '');
  setText(s.stGlyph, view?.glyph ?? '');
  setText(s.stWord, view?.word ?? '');
  setText(s.qt, view?.text ?? '');
  setText(s.when, view?.at ? `You steered · ${clock(view.at)}` : '');
  swapText(s.sub, view?.sub ?? '', { animate });
  setClass(s.sub, 'warn', view?.warn || view?.st === 'failed' || view?.st === 'unclaimed');
  s.text = view?.text ?? '';
  s.again.hidden = !(view?.again && can);

  const wantDrain = Boolean(st && st.drainMs > 0 && !card._sending && !card._sendError);
  if (wantDrain) {
    if (!s.drain || s.drainFor !== last.id) {
      s.drain?.remove();
      s.drain = el('i', { class: 'drain' });
      s.drain.style.animationDelay = `-${STEER_DRAIN_MS - st.drainMs}ms`;
      s.drainFor = last.id;
      s.row.appendChild(s.drain);
    }
  } else if (s.drain) {
    s.drain.remove();
    s.drain = null;
    s.drainFor = null;
  }
}
