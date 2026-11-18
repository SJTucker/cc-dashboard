'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function worker(over = {}) {
  return {
    agentId: 'ag1', task: 1, title: 'Add the parser', status: 'working', canSteer: true,
    startedAt: iso(-600_000), lastActiveAt: iso(-5_000), contextTokens: 40000,
    files: ['a.js', 'b.js'], touched: ['a.js'], steerCount: 0, lastSteer: null,
    current: { tool: 'Edit', text: 'a.js' }, steps: [{ line: 1, time: iso(-60_000), tool: 'Read', text: 'a.js' }],
    ...over,
  };
}

function detail(over = {}) {
  return {
    id: 'orch1', topic: 'Parser rewrite', project: 'cc', branch: 'feat', live: true, phase: 'waves', wave: 1,
    now: { state: 'working', text: 'Waiting on wave 1', detail: '1 worker', since: iso(-120_000) },
    waves: [{ n: 1, startedAt: iso(-600_000), workers: [worker()] }],
    feed: [{ at: iso(-30_000), line: 7, glyph: '▸', text: 'Started wave 1' }],
    board: [{ t: iso(-90_000), from: 'ag1', title: 'Heads up', body: 'x' }],
    ...over,
  };
}

let root;
let render;
beforeEach(async () => {
  installDom();
  root = document.createElement('div');
  render = await import('../public/orchestration/render.mjs');
});

const actions = (over = {}) => ({
  sendBoardPost: async () => ({ ok: true, status: 201, data: { t: iso(0) } }),
  sendSteer: async () => ({ ok: true, status: 202, data: { id: 'req1' } }),
  ...over,
});

test('renderDetail draws a Detail that has no now, board, waves or feed', () => {
  render.renderDetail(root, { id: 'x', live: true, phase: 'plan' }, { now: NOW, actions: actions() });
  assert.equal(root.querySelector('.now-line').querySelector('.tx').textContent, '');
  assert.equal(root.querySelector('.orch-waves').children.length, 0);
  assert.equal(root.querySelector('.feed').children.length, 0);
  assert.equal(root.querySelector('.board-list').children.length, 0);
  // A wave with no workers array renders too.
  render.renderDetail(root, { id: 'x', live: true, phase: 'waves', waves: [{ n: 1 }] }, { now: NOW, actions: actions() });
  assert.equal(root.querySelector('.orch-waves').children.length, 1);
  assert.equal(root.querySelector('.orch-waves').children[0].querySelector('.orch-workers').children.length, 0);
  assert.equal(root.querySelector('.orch-waves-panel').querySelector('.orch-empty').hidden, true);
});

test('renderDetail throws a clear error when the actions are missing', () => {
  assert.throws(() => render.renderDetail(root, detail(), { now: NOW }), /actions/);
  assert.throws(() => render.renderDetail(root, detail(), { now: NOW, actions: { sendBoardPost() {} } }), /sendSteer/);
  assert.throws(() => render.renderDetail(root, detail(), { now: NOW, actions: { sendSteer() {} } }), /sendBoardPost/);
});

test('a worker with no startedAt shows a dash, and one with no task shows its title and a generic Steer label', () => {
  const bare = worker({ startedAt: undefined, task: undefined });
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [bare] }] }), { now: NOW, actions: actions() });
  const card = root.querySelector('.worker');
  assert.equal(card.querySelector('.w-meta').textContent.includes('NaN'), false);
  assert.match(card.querySelector('.w-meta').textContent, /run —/);
  assert.equal(card.querySelector('.w-title').textContent, 'Add the parser');
  assert.equal(byText(card, 'Steer').getAttribute('aria-label'), 'Steer this worker');
  assert.equal(card.textContent.includes('undefined'), false);
});

test('a second poll with the same Detail keeps every node, and one changed worker changes only its text', () => {
  render.renderDetail(root, detail(), { now: NOW, actions: actions() });
  const pick = () => {
    const card = root.querySelector('.worker');
    return {
      card,
      title: card.querySelector('.w-title'),
      status: card.querySelector('.badge'),
      foot: card.querySelector('.meters'),
      slot: card.querySelector('.w-compose'),
      steps: card.querySelector('.steps'),
    };
  };
  const before = pick();
  const footText = before.foot.textContent;
  const actText = before.card.querySelector('.w-tool').querySelector('code').textContent;
  render.renderDetail(root, detail(), { now: NOW + 3000, actions: actions() });
  const same = pick();
  for (const key of Object.keys(before)) assert.strictEqual(same[key], before[key], key);

  // Open the card so the step rows exist, then change one worker.
  before.card.querySelector('.chev').click();
  const rowsBefore = [...before.card.querySelector('.steps').children];
  assert.equal(rowsBefore.length, 1);
  const changed = detail({ waves: [{ n: 1, startedAt: iso(-600_000), workers: [worker({ status: 'stuck', steps: [
    { line: 1, time: iso(-60_000), tool: 'Read', text: 'a.js' },
    { line: 2, time: iso(-10_000), tool: 'Edit', text: 'b.js' },
  ] })] }] });
  const statusText = before.status.textContent;
  assert.equal(before.foot.textContent, footText);
  render.renderDetail(root, changed, { now: NOW + 6000, actions: actions() });
  const after = pick();
  for (const key of Object.keys(before)) assert.strictEqual(after[key], before[key], key);
  assert.notEqual(after.status.textContent, statusText);
  assert.match(after.status.textContent, /Stuck/);
  assert.equal(after.foot.textContent, footText);
  assert.equal(after.card.querySelector('.w-tool').querySelector('code').textContent, actText);
  assert.equal(after.title.textContent, 'Add the parser');
  assert.equal(after.card.querySelector('.tid').textContent, 'T1');
  const rows = [...after.steps.children];
  assert.equal(rows.length, 2);
  assert.ok(rows.includes(rowsBefore[0]), 'the existing step row is reused');
});

test('a merge that swaps one card for a merged row leaves the later cards in place', () => {
  const two = (first) => detail({ waves: [{ n: 1, startedAt: iso(-600_000), workers: [first, worker({ agentId: 'ag2', task: 2, title: 'Second' })] }] });
  render.renderDetail(root, two(worker()), { now: NOW, actions: actions() });
  const body = root.querySelector('.orch-workers');
  const second = [...body.children].find((c) => c.dataset.key === 'ag2:card');
  const calls = [];
  const original = body.insertBefore.bind(body);
  body.insertBefore = (child, ref) => { calls.push(child); return original(child, ref); };
  render.renderDetail(root, two(worker({ status: 'merged', mergedAt: iso(-1000) })), { now: NOW + 3000, actions: actions() });
  assert.equal(calls.includes(second), false, 'the second card is not moved');
  assert.strictEqual([...body.children].find((c) => c.dataset.key === 'ag2:card'), second);
  assert.deepEqual([...body.children].map((c) => c.dataset.key), ['ag1:fin', 'ag2:card']);
});

test('a stuck worker with no task is named generically in the banner', () => {
  const stuck = worker({ task: null, status: 'stuck', events: [{ type: 'KILLED', text: 'KILLED the worker', at: iso(-1000) }] });
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [stuck] }] }), { now: NOW, actions: actions() });
  const banner = root.querySelector('.banner');
  assert.equal(banner.querySelector('h3').textContent, 'A worker is stuck · KILLED');
  assert.equal(byText(banner, 'Steer this worker') != null, true);
  assert.equal(banner.textContent.includes('null'), false);
});

// ---------- Composers ----------

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const byText = (node, text) => [...node.querySelectorAll('.orch-btn')].find((b) => b.textContent === text);
const boardForm = () => root.querySelector('.orch-composer');
const boardField = () => boardForm().querySelectorAll('.orch-field')[0];
const postButton = () => byText(boardForm(), 'Post');
const steerParts = () => {
  const card = root.querySelector('.worker');
  const form = card.querySelector('.steer-form');
  return {
    card,
    open: byText(card, 'Steer'),
    form,
    input: form.querySelector('.orch-field'),
    send: byText(card, 'Send'),
    status: card.querySelector('.sub'),
    state: card.querySelector('.state'),
    error: form.querySelector('.orch-error'),
  };
};

test('a posted note stays through a poll that does not list it, and the 201 gives it the key a poll uses', async () => {
  const gate = deferred();
  const t = iso(0);
  const acts = actions({ sendBoardPost: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  boardField().value = 'My note';
  const submitted = boardForm().requestSubmit();
  const list = root.querySelector('.board-list');
  const pending = list.querySelector('[data-pending]');
  assert.ok(pending);
  assert.equal(list.firstChild, pending);
  // A poll without the post leaves the pending node in place.
  render.renderDetail(root, detail(), { now: NOW + 3000, actions: acts });
  assert.strictEqual(list.querySelector('[data-pending]'), pending);
  gate.resolve({ ok: true, status: 201, data: { t } });
  await submitted;
  assert.equal(pending.dataset.key, `${t}You`);
  // The poll that lists it reuses the node and clears data-pending.
  const listed = detail({ board: [{ t, from: 'You', title: 'My note', body: '' }, ...detail().board] });
  render.renderDetail(root, listed, { now: NOW + 6000, actions: acts });
  assert.strictEqual(list.querySelector('.post'), pending);
  assert.equal(pending.hasAttribute('data-pending'), false);
  assert.equal(list.children.length, 2);
});

test('a poll that lists the post before the 201 arrives replaces the pending node at once', async () => {
  const gate = deferred();
  const acts = actions({ sendBoardPost: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  boardField().value = 'My note';
  const submitted = boardForm().requestSubmit();
  const list = root.querySelector('.board-list');
  const pending = list.querySelector('[data-pending]');
  const t = new Date().toISOString();
  render.renderDetail(root, detail({ board: [{ t, from: 'You', title: 'My note', body: '' }, ...detail().board] }), { now: Date.now(), actions: acts });
  assert.equal(list.children.length, 2, 'no solid copy beside the pending post');
  assert.strictEqual(list.firstChild, pending);
  assert.equal(pending.hasAttribute('data-pending'), false);
  gate.resolve({ ok: true, status: 201, data: { t } });
  await submitted;
  assert.equal(list.children.length, 2);
  assert.strictEqual(list.firstChild, pending);
});

test('a listed post with another title or sender does not replace a pending post', async () => {
  const gate = deferred();
  const acts = actions({ sendBoardPost: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  boardField().value = 'My note';
  boardForm().requestSubmit();
  const list = root.querySelector('.board-list');
  const t = new Date().toISOString();
  render.renderDetail(root, detail({ board: [{ t, from: 'ag1', title: 'My note', body: '' }, { t, from: 'You', title: 'Other', body: '' }] }), { now: Date.now(), actions: acts });
  assert.equal(list.children.length, 3);
  assert.equal(list.querySelectorAll('[data-pending]').length, 1);
});

test('two submits of the board form make one request', async () => {
  const gate = deferred();
  let calls = 0;
  const acts = actions({ sendBoardPost: () => { calls++; return gate.promise; } });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  boardField().value = 'My note';
  const first = boardForm().requestSubmit();
  boardField().value = 'Again';
  const second = boardForm().requestSubmit();
  assert.equal(calls, 1);
  assert.equal(postButton().getAttribute('aria-disabled'), 'true');
  gate.resolve({ ok: true, status: 201, data: { t: iso(0) } });
  await Promise.all([first, second]);
  assert.equal(postButton().hasAttribute('aria-disabled'), false);
});

test('two submits of the steer form make one request', async () => {
  const gate = deferred();
  let calls = 0;
  const acts = actions({ sendSteer: () => { calls++; return gate.promise; } });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  const p = steerParts();
  await p.open.click();
  p.input.value = 'Use the cache';
  const first = p.form.requestSubmit();
  const second = p.form.requestSubmit();
  assert.equal(calls, 1);
  gate.resolve({ ok: true, status: 202, data: { id: 'req1' } });
  await Promise.all([first, second]);
  assert.equal(steerParts().status.textContent, 'Sending…');
  assert.match(steerParts().state.textContent, /Pending/);
});

test('a poll leaves an open steer form alone, and Steer hides when canSteer or live turns false', async () => {
  render.renderDetail(root, detail(), { now: NOW, actions: actions() });
  let p = steerParts();
  assert.equal(p.open.hidden, false);
  await p.open.click();
  p.input.value = 'half typed';
  assert.equal(p.form.hidden, false);
  const noSteer = detail({ waves: [{ n: 1, workers: [worker({ canSteer: false })] }] });
  render.renderDetail(root, noSteer, { now: NOW + 3000, actions: actions() });
  p = steerParts();
  assert.equal(p.form.hidden, false, 'the open form stays');
  assert.equal(p.input.value, 'half typed');
  assert.equal(document.activeElement, p.input);
  await p.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(p.form.hidden, true);
  assert.equal(p.open.hidden, true, 'Steer stays hidden when the worker cannot be steered');
  render.renderDetail(root, detail(), { now: NOW + 6000, actions: actions() });
  assert.equal(p.open.hidden, false);
  render.renderDetail(root, detail({ live: false }), { now: NOW + 9000, actions: actions() });
  assert.equal(p.open.hidden, true, 'Steer hides when the orchestration is not live');
});

test('a non-live orchestration shows no Steer button and no board composer', () => {
  render.renderDetail(root, detail({ live: false }), { now: NOW, actions: actions() });
  assert.equal(steerParts().open.hidden, true);
  assert.equal(boardForm().hidden, true);
});

test('an Escape during a steer request that then fails shows the error in the status line', async () => {
  const gate = deferred();
  const acts = actions({ sendSteer: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  let p = steerParts();
  await p.open.click();
  p.input.value = 'Use the cache';
  const submitted = p.form.requestSubmit();
  await p.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(p.form.hidden, true);
  gate.resolve({ ok: false, status: 409, data: { error: 'worker finished' } });
  await submitted;
  p = steerParts();
  assert.equal(p.status.textContent, 'This worker has finished, so it was not steered.');
  assert.equal(p.status.classList.contains('warn'), true);
  assert.equal(p.error.hidden, true);
  assert.equal(p.error.textContent, '');
});

test('a send that fails after Esc offers Steer again with the old text', async () => {
  const gate = deferred();
  const acts = actions({ sendSteer: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  let p = steerParts();
  await p.open.click();
  p.input.value = 'Use the cache';
  const submitted = p.form.requestSubmit();
  await p.input.dispatch('keydown', { key: 'Escape' });
  gate.resolve({ ok: false, status: 409, data: { error: 'worker finished' } });
  await submitted;
  const again = byText(root.querySelector('.worker'), 'Steer again');
  assert.equal(again.hidden, false);
  await again.click();
  p = steerParts();
  assert.equal(p.form.hidden, false);
  assert.equal(p.input.value, 'Use the cache');
});

test('the owner\'s own post is never new, and a pending seen timer does not move the marker', async () => {
  const acts = actions();
  const others = [5, 4, 3, 2, 1].map((n) => ({ t: iso(-n * 60_000), from: 'ag1', title: `Post ${n}`, body: '' }));
  // 3 of the 5 posts from others are seen, and the viewer posts.
  render.renderDetail(root, detail({ board: others }), { now: NOW, actions: acts, seenBoard: 3 });
  boardField().value = 'My note';
  await boardForm().requestSubmit();
  const list = root.querySelector('.board-list');
  const own = list.firstChild;
  const t = own.dataset.key.replace(/You$/, '');
  const six = [{ t, from: 'You', title: 'My note', body: '' }, ...others];
  render.renderDetail(root, detail({ board: six }), { now: Date.now(), actions: acts, seenBoard: 3 });
  assert.strictEqual(list.firstChild, own);
  const marked = [...list.children].filter((li) => li.classList.contains('new')).map((li) => li.querySelector('.post-title').textContent);
  assert.deepEqual(marked, ['Post 5', 'Post 4']);
  assert.match(root._orch.boardMeta.textContent, /^6 posts · 2 new$/);
});

test('removing the Orchestration tab hides its controls, stops the poller, clears state and leaves the tab', async () => {
  const { removeOrchestrationTab } = await import('../public/panels/orchestration.mjs');
  const tabButton = document.createElement('button');
  const badge = document.createElement('span');
  const log = [];
  const poller = { stop: () => log.push('stop') };
  const loc = { hash: '#orchestration' };
  removeOrchestrationTab({ tabButton, badge, poller, location: loc, onTab: true, clearState: () => log.push('clear') });
  assert.equal(tabButton.hidden, true);
  assert.equal(badge.hidden, true);
  assert.deepEqual(log, ['stop', 'clear']);
  assert.equal(loc.hash, 'now');
  const other = { hash: '#analysis' };
  removeOrchestrationTab({ tabButton, badge, poller, location: other, onTab: false, clearState() {} });
  assert.equal(other.hash, '#analysis');
});

test('a steer error from a closed form expires when the worker has a newer steer or cannot be steered', async () => {
  const gate = deferred();
  const acts = actions({ sendSteer: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  let p = steerParts();
  await p.open.click();
  p.input.value = 'Use the cache';
  const submitted = p.form.requestSubmit();
  await p.input.dispatch('keydown', { key: 'Escape' });
  gate.resolve({ ok: false, status: 409, data: { error: 'worker finished' } });
  await submitted;
  assert.match(steerParts().status.textContent, /has finished/);
  render.renderDetail(root, detail(), { now: NOW + 3000, actions: acts });
  assert.match(steerParts().status.textContent, /has finished/, 'a poll with no new steer keeps it');
  const newer = detail({ waves: [{ n: 1, workers: [worker({ lastSteer: { id: 'r9', state: 'pending' } })] }] });
  render.renderDetail(root, newer, { now: NOW + 6000, actions: acts });
  assert.match(steerParts().state.textContent, /Pending/);
  assert.match(steerParts().status.textContent, /Waiting for the orchestrator session/);
});

test('a steer error from a closed form expires when canSteer turns false', async () => {
  const gate = deferred();
  const acts = actions({ sendSteer: () => gate.promise });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  const p = steerParts();
  await p.open.click();
  p.input.value = 'x';
  const submitted = p.form.requestSubmit();
  await p.input.dispatch('keydown', { key: 'Escape' });
  gate.resolve({ ok: false, status: 500, data: {} });
  await submitted;
  assert.match(steerParts().status.textContent, /Could not send/);
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [worker({ canSteer: false })] }] }), { now: NOW + 3000, actions: acts });
  assert.equal(steerParts().status.textContent, '');
});

test('the board composer limits the title to 120 characters and the details to 2000, and words a 400 for long text', async () => {
  const acts = actions({ sendBoardPost: async () => ({ ok: false, status: 400, data: {} }) });
  render.renderDetail(root, detail(), { now: NOW, actions: acts });
  assert.equal(boardField().getAttribute('maxlength'), '120');
  assert.equal(boardForm().querySelectorAll('.orch-field')[1].getAttribute('maxlength'), '2000');
  boardField().value = 'A title';
  await boardForm().requestSubmit();
  assert.equal(boardForm().querySelector('.orch-error').textContent, 'The title or details are too long.');
});

test('a finished worker with no lastActiveAt shows a dash for worked, not a growing time', () => {
  const w = worker({ status: 'done', lastActiveAt: null });
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [w] }] }), { now: NOW, actions: actions() });
  assert.match(root.querySelector('.worker').querySelector('.w-meta').textContent, /worked —/);
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [w] }] }), { now: NOW + 3_600_000, actions: actions() });
  assert.match(root.querySelector('.worker').querySelector('.w-meta').textContent, /worked —/);
});

test('removing the Orchestration tab empties the detail and switcher, so a later visit shows nothing', async () => {
  const { removeOrchestrationTab } = await import('../public/panels/orchestration.mjs');
  const view = document.createElement('div');
  const switcher = document.createElement('div');
  view.appendChild(document.createElement('section'));
  switcher.appendChild(document.createElement('button'));
  removeOrchestrationTab({
    tabButton: document.createElement('button'), badge: document.createElement('span'), poller: { stop() {} },
    location: { hash: '#now' }, onTab: false, clearState() {}, views: [view, switcher],
  });
  assert.equal(view.children.length, 0);
  assert.equal(switcher.children.length, 0);
});

test('a visit to #orchestration after the tab was removed is sent back to #now', async () => {
  const { redirectFromRemovedTab } = await import('../public/panels/orchestration.mjs');
  const loc = { hash: '#orchestration' };
  assert.equal(redirectFromRemovedTab('orchestration', { settled: true, installed: false }, loc), true);
  assert.equal(loc.hash, 'now');
  for (const [tab, gate] of [['orchestration', { settled: true, installed: true }], ['orchestration', { settled: false, installed: false }], ['now', { settled: true, installed: false }]]) {
    const other = { hash: '#' + tab };
    assert.equal(redirectFromRemovedTab(tab, gate, other), false);
    assert.equal(other.hash, '#' + tab);
  }
});

test('the steer button and message input name the task with its title', async () => {
  const titled = detail({ waves: [{ n: 1, workers: [worker({ task: 3, title: 'Fix the regex' })] }] });
  render.renderDetail(root, titled, { now: NOW, actions: actions() });
  let p = steerParts();
  assert.equal(p.open.getAttribute('aria-label'), 'Steer Task 3 (Fix the regex)');
  await p.open.click();
  assert.equal(p.input.getAttribute('aria-label'), 'Message to the Task 3 (Fix the regex) worker');
  const bare = detail({ waves: [{ n: 1, workers: [worker({ task: 3, title: null })] }] });
  render.renderDetail(root, bare, { now: NOW + 3000, actions: actions() });
  p = steerParts();
  assert.equal(p.open.getAttribute('aria-label'), 'Steer Task 3');
});

// ---------- Run switcher cards ----------

function summary(over = {}) {
  return {
    id: 'run1', topic: 'Parser rewrite', project: 'cc', branch: 'feat', live: true, waiting: false, phase: 'waves', wave: 2,
    lastActiveAt: iso(-60_000), boardCount: 3, counts: { working: 2, review: 0, merged: 1, attention: 0 },
    ...over,
  };
}

const drawCards = (list, selected = 'run1') => render.renderSwitcher(root, list, selected, () => {}, NOW);

test('a run card shows its pill, meta line, four phase pips and four counts', () => {
  drawCards([summary()]);
  const card = root.querySelector('.run');
  assert.equal(card.querySelector('.run-name').textContent, 'Parser rewrite');
  assert.equal(card.querySelector('.run-pill').textContent, '● Live');
  assert.ok(card.querySelector('.run-meta').textContent.includes('last active'));
  assert.equal(card.querySelectorAll('.pip').length, 4);
  assert.equal(card.querySelector('.run-pip-labels').querySelectorAll('span').length, 4);
  const counts = [...card.querySelectorAll('.cnt')];
  assert.equal(counts.length, 4);
  assert.deepEqual(counts.map((c) => c.querySelector('b').textContent), ['2', '0', '1', '0']);
  assert.ok(counts[0].textContent.includes('working') && counts[1].textContent.includes('review') && counts[2].textContent.includes('merged') && counts[3].textContent.includes('attention'));
  assert.deepEqual([...card.querySelectorAll('.pip')].map((p) => (p.classList.contains('done') ? 'done' : p.classList.contains('now') ? 'now' : 'next')), ['done', 'done', 'now', 'next']);
});

test("a waiting run's current pip carries wait and its pill reads Waiting for you", () => {
  drawCards([summary({ waiting: true })]);
  const card = root.querySelector('.run');
  assert.equal(card.querySelector('.run-pill').textContent, '⏸ Waiting for you');
  const now = [...card.querySelectorAll('.pip')].filter((p) => p.classList.contains('now'));
  assert.equal(now.length, 1);
  assert.ok(now[0].classList.contains('wait'));
  assert.equal([...card.querySelectorAll('.pip')].filter((p) => p.classList.contains('wait')).length, 1);
});

test('zero counts are dimmed and attention above zero is amber', () => {
  drawCards([summary({ counts: { working: 2, review: 0, merged: 0, attention: 1 } })]);
  const [working, review, merged, attention] = root.querySelectorAll('.cnt');
  assert.ok(!working.classList.contains('zero') && !working.classList.contains('warn'));
  assert.ok(review.classList.contains('zero'));
  assert.ok(merged.classList.contains('zero'));
  assert.ok(attention.classList.contains('warn') && !attention.classList.contains('zero'));
});

test('a poll with one changed count keeps the card node and changes only that number', () => {
  drawCards([summary()]);
  const card = root.querySelector('.run');
  const before = [...card.querySelectorAll('.cnt')].map((c) => c.querySelector('b').textContent);
  drawCards([summary({ counts: { working: 2, review: 0, merged: 2, attention: 0 } })]);
  assert.equal(root.querySelector('.run'), card);
  const after = [...card.querySelectorAll('.cnt')].map((c) => c.querySelector('b').textContent);
  assert.deepEqual(before, ['2', '0', '1', '0']);
  assert.deepEqual(after, ['2', '0', '2', '0']);
});

test('the selected card keeps aria-pressed', () => {
  drawCards([summary(), summary({ id: 'run2' })], 'run2');
  const [a, b] = root.querySelectorAll('.run');
  assert.equal(a.getAttribute('aria-pressed'), 'false');
  assert.equal(b.getAttribute('aria-pressed'), 'true');
});

test('flashText flashes only a changed value', async () => {
  const { flashText } = await import('../public/orchestration/motion.mjs');
  const { StubNode } = require('./dom-stub');
  const node = new StubNode('b');
  let calls = 0;
  node.animate = () => { calls += 1; };
  flashText(node, '1');
  assert.equal(calls, 0);
  flashText(node, '2');
  assert.equal(calls, 1);
  assert.equal(node.textContent, '2');
  flashText(node, '2');
  assert.equal(calls, 1);
  flashText(node, '3', { animate: false });
  assert.equal(calls, 1);
  assert.equal(node.textContent, '3');
});

// ---------- Attention banner, status block, board and feed ----------

const stuckWorker = (over = {}) => worker({
  agentId: 'agS', task: 2, title: 'Wire the cache', status: 'stuck',
  events: [{ type: 'STUCK', text: 'STUCK Bash failed 3 times.', at: iso(-60_000) }],
  ...over,
});
const waitingDetail = (over = {}) => detail({
  now: { state: 'waiting', text: 'Waiting for you', detail: 'Which branch should I merge into?', since: iso(-120_000) },
  ...over,
});
const banners = () => [...root.querySelector('.orch-banner').querySelectorAll('.banner')];

async function withClipboard(writeText, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText } }, configurable: true, writable: true });
  try { await fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete globalThis.navigator;
  }
}

test('a waiting live run shows a waiting banner with the question and Copy question', async () => {
  const { clock } = await import('../public/orchestration/view.mjs');
  render.renderDetail(root, waitingDetail(), { now: NOW, actions: actions() });
  const found = banners();
  assert.equal(found.length, 1);
  const text = found[0].textContent;
  assert.ok(text.includes('Which branch should I merge into?'));
  assert.ok(text.includes("Answer in the orchestrator's terminal session."));
  assert.ok(text.includes('The orchestrator is waiting for you'));
  assert.ok(text.includes(`asked ${clock(iso(-120_000))}`));
  assert.ok(byText(found[0], 'Copy question'));
  assert.equal(root.querySelector('.now-line').querySelector('.tx').textContent, 'Waiting for you');
});

test('Copy question writes the question to the clipboard and reads Copied, or Copy failed when refused', async () => {
  const written = [];
  let calls = 0;
  await withClipboard((text) => { written.push(text); return ++calls === 1 ? Promise.resolve() : Promise.reject(new Error('denied')); }, async () => {
    render.renderDetail(root, waitingDetail(), { now: NOW, actions: actions() });
    const copy = byText(banners()[0], 'Copy question');
    await copy.click();
    assert.deepEqual(written, ['Which branch should I merge into?']);
    assert.equal(copy.textContent, 'Copied');
    await copy.click();
    assert.equal(copy.textContent, 'Copy failed');
  });
  await withClipboard(undefined, async () => {
    const root2 = document.createElement('div');
    render.renderDetail(root2, waitingDetail({ id: 'o2' }), { now: NOW, actions: actions() });
    const copy = byText(root2.querySelector('.orch-banner'), 'Copy question');
    await copy.click();
    assert.equal(copy.textContent, 'Copy failed');
  });
});

test('a stuck worker adds an entry after the waiting entry, and its Steer button opens that worker\'s steer form', async () => {
  const d = waitingDetail({ waves: [{ n: 1, startedAt: iso(-600_000), workers: [stuckWorker({ lastSteer: { id: 'r1', state: 'pending', at: iso(-30_000) } })] }] });
  render.renderDetail(root, d, { now: NOW, actions: actions() });
  assert.deepEqual(banners().map((b) => b.dataset.key), ['waiting', 'stuck:agS']);
  const stuck = banners()[1];
  assert.ok(stuck.textContent.includes('Task 2 is stuck · STUCK'));
  assert.ok(stuck.textContent.includes('STUCK Bash failed 3 times. Steer it back on track.'));
  assert.ok(stuck.textContent.includes('is waiting for pickup.'));
  const nowText = root.querySelector('.now-line').textContent;
  assert.ok(nowText.includes('Waiting for you'), 'waiting wins the now line');
  let scrolled = 0;
  root.querySelector('.worker').scrollIntoView = (opts) => { scrolled += 1; assert.deepEqual(opts, { block: 'center' }); };
  await byText(stuck, 'Steer Task 2').click();
  assert.equal(scrolled, 1);
  assert.equal(root.querySelector('.worker').querySelector('.steer-form').hidden, false);
});

test('two stuck workers give two entries, and each Steer button opens its own worker\'s form', async () => {
  const a = stuckWorker({ agentId: 'agA', task: 3 });
  const b = stuckWorker({ agentId: 'agB', task: 1 });
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [a, b] }] }), { now: NOW, actions: actions() });
  assert.deepEqual(banners().map((x) => x.dataset.key), ['stuck:agB', 'stuck:agA']);
  assert.ok(root.querySelector('.now-line').textContent.includes('Task 1 stuck, STUCK'));
  await byText(banners()[0], 'Steer Task 1').click();
  const cards = [...root.querySelectorAll('.worker')];
  const form = (key) => cards.find((c) => c._agentId === key).querySelector('.steer-form');
  assert.equal(form('agB').hidden, false);
  assert.equal(form('agA').hidden, true);
  await byText(banners()[1], 'Steer Task 3').click();
  assert.equal(form('agA').hidden, false);
});

test('an ended run shows no Steer button in the banner and no Post a note', () => {
  render.renderDetail(root, detail({ live: false, waves: [{ n: 1, workers: [stuckWorker()] }] }), { now: NOW, actions: actions() });
  assert.equal(banners().length, 1);
  assert.equal(byText(banners()[0], 'Steer Task 2').hidden, true);
  assert.equal(root.querySelector('.orch-board').querySelector('.orch-btn').hidden, true);
  assert.equal(root.querySelector('.orch-composer').hidden, true);
});

test('with nothing waiting or stuck the banner is empty and the quiet line shows', () => {
  render.renderDetail(root, detail(), { now: NOW, actions: actions() });
  assert.equal(banners().length, 0);
  assert.equal(root.querySelector('.quiet-line').hidden, false);
  assert.equal(root.querySelector('.quiet-line').textContent, '✓ Nothing needs you right now.');
  render.renderDetail(root, waitingDetail(), { now: NOW + 3000, actions: actions() });
  assert.equal(root.querySelector('.quiet-line').hidden, true);
});

test('the wave strip has one segment per wave and the live last one reads so far', () => {
  const waves = [
    { n: 1, startedAt: iso(-3_600_000), endedAt: iso(-1_200_000), workers: [worker({ agentId: 'a', status: 'merged' })] },
    { n: 2, startedAt: iso(-1_200_000), endedAt: null, workers: [worker()] },
  ];
  render.renderDetail(root, detail({ waves }), { now: NOW, actions: actions() });
  const segs = root.querySelector('.wave-strip').querySelectorAll('.seg');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].textContent, 'W1 40m');
  assert.equal(segs[1].textContent, 'W2 20m so far');
  assert.equal(segs[0].classList.contains('live'), false);
  assert.equal(segs[1].classList.contains('live'), true);
  render.renderDetail(root, detail({ live: false, waves }), { now: NOW + 3000, actions: actions() });
  assert.equal(root.querySelector('.wave-strip').querySelectorAll('.seg')[1].textContent.includes('so far'), false);
});

test('an empty board is one row, and its composer opens on Post a note and keeps its draft after Cancel and a poll', async () => {
  render.renderDetail(root, detail({ board: [] }), { now: NOW, actions: actions() });
  const board = root.querySelector('.orch-board');
  assert.ok(board.classList.contains('empty'));
  assert.equal(board.querySelector('.panel-meta').textContent, 'No notes yet');
  assert.equal(boardForm().hidden, true);
  const open = byText(board, 'Post a note');
  await open.click();
  assert.equal(boardForm().hidden, false);
  boardField().value = 'half a note';
  await byText(boardForm(), 'Cancel').click();
  assert.equal(boardForm().hidden, true);
  render.renderDetail(root, detail({ board: [] }), { now: NOW + 3000, actions: actions() });
  assert.equal(boardForm().hidden, true);
  await open.click();
  assert.equal(boardField().value, 'half a note');
  await boardField().dispatch('keydown', { key: 'Escape' });
  assert.equal(boardForm().hidden, true);
  assert.equal(boardField().value, 'half a note');
  render.renderDetail(root, detail(), { now: NOW + 6000, actions: actions() });
  assert.equal(root.querySelector('.orch-board').classList.contains('empty'), false);
  assert.equal(root.querySelector('.orch-board').querySelector('.panel-meta').textContent, '1 post · 1 new');
});

const feedEntry = (n, glyph, text) => ({ at: iso(-n * 60_000), line: 100 - n, glyph, text });

test('consecutive routine feed entries fold into one group that stays open across a poll', async () => {
  const feed = [feedEntry(1, '·', 'Watching Task 1'), feedEntry(2, '·', 'Checked Task 1'), feedEntry(3, '✓', 'Merged Task 1')];
  render.renderDetail(root, detail({ feed }), { now: NOW, actions: actions() });
  const list = root.querySelector('.feed');
  assert.equal(list.children.length, 2);
  const group = list.children[0];
  assert.ok(group.querySelector('.grp').textContent.includes('2 routine checks'));
  assert.equal(group.querySelector('.grp').getAttribute('aria-expanded'), 'false');
  await group.querySelector('.grp').click();
  assert.equal(group.querySelector('.grp').getAttribute('aria-expanded'), 'true');
  const fresh = [feedEntry(0, '·', 'Watching Task 2'), ...feed];
  render.renderDetail(root, detail({ feed: fresh }), { now: NOW + 3000, actions: actions() });
  assert.strictEqual(list.children[0], group);
  assert.equal(group.querySelector('.grp').getAttribute('aria-expanded'), 'true');
  assert.ok(group.querySelector('.grp').textContent.includes('3 routine checks'));
  assert.equal(group.querySelector('.sub-list').children.length, 3);
  const merge = list.children[1];
  assert.ok(merge.classList.contains('merge'));
});

test('a feed of only routine entries is one group, and steer entries get the you class', () => {
  render.renderDetail(root, detail({ feed: [feedEntry(1, '·', 'a'), feedEntry(2, '·', 'b')] }), { now: NOW, actions: actions() });
  assert.equal(root.querySelector('.feed').children.length, 1);
  render.renderDetail(root, detail({ feed: [feedEntry(1, '↗', 'Steered Task 1')] }), { now: NOW + 3000, actions: actions() });
  assert.ok(root.querySelector('.feed').children[0].classList.contains('you'));
});

test('the feed header counts key and folded entries', () => {
  const feed = [feedEntry(1, '·', 'a'), feedEntry(2, '·', 'b'), feedEntry(3, '✓', 'Merged'), feedEntry(4, '▸', 'Started wave 1')];
  render.renderDetail(root, detail({ feed }), { now: NOW, actions: actions() });
  assert.equal(root.querySelector('.orch-feed-panel').querySelector('.panel-meta').textContent, '2 key · 2 routine folded');
});

test('the now line names a stuck task, and a stuck banner entry shows its steer meta', () => {
  const w = stuckWorker({ lastSteer: { id: 'r1', state: 'delivered', at: iso(-30_000) } });
  render.renderDetail(root, detail({ waves: [{ n: 1, workers: [w] }] }), { now: NOW, actions: actions() });
  assert.ok(root.querySelector('.now-line').textContent.includes('Task 2 stuck, STUCK'));
  assert.ok(root.querySelector('.now-line').classList.contains('warn'));
  assert.ok(banners()[0].textContent.includes('Watching for a change.'));
});

test('a poll keeps the banner nodes, and a steer form opened from the banner stays open', async () => {
  const d = () => detail({ waves: [{ n: 1, workers: [stuckWorker()] }] });
  render.renderDetail(root, d(), { now: NOW, actions: actions() });
  const banner = banners()[0];
  await byText(banner, 'Steer Task 2').click();
  render.renderDetail(root, d(), { now: NOW + 3000, actions: actions() });
  assert.strictEqual(banners()[0], banner);
  assert.equal(root.querySelector('.worker').querySelector('.steer-form').hidden, false);
});

test('a poll while the board composer is open leaves it visible with its draft', async () => {
  render.renderDetail(root, detail(), { now: NOW, actions: actions() });
  await byText(root.querySelector('.orch-board'), 'Post a note').click();
  boardField().value = 'draft in progress';
  render.renderDetail(root, detail(), { now: NOW + 3000, actions: actions() });
  assert.equal(boardForm().hidden, false);
  assert.equal(boardField().value, 'draft in progress');
});

// ---------- Worker cards, merged rows, earlier waves and the steer row ----------

const viewMod = () => import('../public/orchestration/view.mjs');
const inCard = (cls) => root.querySelector('.worker').querySelector(cls);
const oneWave = (...workers) => detail({ waves: [{ n: 1, startedAt: iso(-600_000), workers }] });
const mergedWorker = (over = {}) => worker({
  agentId: 'agM', task: 4, title: 'Ship the parser', status: 'merged', canSteer: false,
  startedAt: iso(-600_000), lastActiveAt: iso(-400_000), mergedAt: iso(-360_000),
  files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], report: 'Everything shipped.',
  reviews: [{ status: 'changes', startedAt: iso(-500_000) }, { status: 'passed', startedAt: iso(-450_000) }],
  ...over,
});

test('a working card shows the whole tool call with newlines kept', () => {
  const text = `${'a'.repeat(59)}\n${'b'.repeat(60)}`;
  render.renderDetail(root, oneWave(worker({ current: { tool: 'Bash', text } })), { now: NOW, actions: actions() });
  assert.equal(inCard('.w-tool').querySelector('code').textContent, text);
  assert.equal(inCard('.w-tool').querySelector('.tool').textContent, 'Bash');
});

test('a stuck card shows a cause row with the event type', () => {
  const w = stuckWorker({ events: [{ type: 'DRIFT', text: 'DRIFT edited x.js outside the plan', at: iso(-60_000) }] });
  render.renderDetail(root, oneWave(w), { now: NOW, actions: actions() });
  assert.equal(inCard('.cause').hidden, false);
  assert.ok(inCard('.cause').textContent.startsWith('DRIFT'));
  render.renderDetail(root, oneWave(worker()), { now: NOW + 3000, actions: actions() });
  assert.equal(inCard('.cause').hidden, true);
});

test('the files meter has one cell per planned file and names files outside the plan', () => {
  const w = worker({
    files: ['lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/d.js'],
    touched: ['/wt/lib/a.js'],
    edited: ['/wt/lib/a.js', '/wt/other.js'],
  });
  render.renderDetail(root, oneWave(w), { now: NOW, actions: actions() });
  const cells = [...inCard('.files').querySelectorAll('.cell')];
  assert.equal(cells.length, 4);
  assert.equal(cells.filter((c) => c.classList.contains('touched')).length, 1);
  assert.ok(inCard('.meters').textContent.includes('1 of 4 planned'));
  assert.ok(inCard('.meters').textContent.includes('1 outside plan'));
  render.renderDetail(root, oneWave(worker({ files: [], touched: [], task: null })), { now: NOW + 3000, actions: actions() });
  assert.ok(inCard('.meters').textContent.includes('No planned files'));
  assert.equal(inCard('.files').querySelectorAll('.cell').length, 0);
  assert.equal(inCard('.meters').textContent.includes('0 of 0'), false);
});

test('the context meter reads used and left, and warns from 150k', () => {
  render.renderDetail(root, oneWave(worker({ contextTokens: 63200 })), { now: NOW, actions: actions() });
  assert.equal(inCard('.ctx-val').textContent, '63.2k of 200k');
  assert.equal(inCard('.ctx-left').textContent, '137k left');
  assert.equal(inCard('.ctx-val').classList.contains('warn'), false);
  render.renderDetail(root, oneWave(worker({ contextTokens: 150000 })), { now: NOW + 3000, actions: actions() });
  assert.ok(inCard('.ctx-val').classList.contains('warn'));
  assert.ok(inCard('.ctx-left').classList.contains('warn'));
  assert.ok(inCard('.ctx-val').textContent.startsWith('! '));
  assert.ok(inCard('.ctx-meter').querySelector('.zone'));
  assert.ok(inCard('.ctx-meter').querySelector('.tick'));
  render.renderDetail(root, oneWave(worker({ contextTokens: 212000 })), { now: NOW + 4000, actions: actions() });
  assert.equal(inCard('.ctx-left').textContent, '12k over');
  render.renderDetail(root, oneWave(worker({ contextTokens: null })), { now: NOW + 6000, actions: actions() });
  assert.equal(inCard('.ctx-val').textContent, '—');
});

test('a merged worker is one row with its merge time, time taken and review history', async () => {
  const { clock } = await viewMod();
  const m = mergedWorker();
  render.renderDetail(root, oneWave(m), { now: NOW, actions: actions() });
  const card = root.querySelector('.worker');
  assert.ok(card.classList.contains('fin'));
  assert.ok(card.querySelector('.sum').textContent.includes('changes asked, then passed'));
  assert.ok(card.querySelector('.sum').textContent.includes('5 files'));
  const head = card.querySelector('.w-head').textContent;
  assert.ok(head.includes(`at ${clock(m.mergedAt)}`));
  assert.ok(head.includes('took 4m'));
  assert.ok(head.includes('Merged'));
  assert.equal(card.querySelector('.meters'), null);
  assert.equal(card.querySelector('.w-tool'), null);
  render.renderDetail(root, oneWave(mergedWorker({ mergedAt: null })), { now: NOW + 3000, actions: actions() });
  const bare = root.querySelector('.worker').querySelector('.w-head').textContent;
  assert.ok(bare.includes('merged'));
  assert.equal(bare.includes('NaN'), false);
  assert.equal(bare.includes('took'), false);
});

test('a passed worker shows its review row in place of the tool row and has no Steer button', () => {
  const w = worker({ status: 'passed', canSteer: false, review: { status: 'passed', startedAt: iso(-200_000), endedAt: iso(-100_000) } });
  render.renderDetail(root, oneWave(w), { now: NOW, actions: actions() });
  assert.ok(inCard('.w-meta').textContent.includes('worked'));
  assert.equal(inCard('.w-tool').hidden, true);
  assert.equal(inCard('.review').hidden, false);
  assert.ok(inCard('.review').textContent.includes('Reviewer passed'));
  assert.equal(byText(root.querySelector('.worker'), 'Steer').hidden, true);
});

test('earlier waves are one row each, listing every task, with took Xm', () => {
  const trio = ['a', 'b', 'c'].map((id, i) => mergedWorker({ agentId: id, task: i + 1, title: `Title ${i + 1}` }));
  const waves = [
    { n: 1, startedAt: iso(-3_600_000), endedAt: iso(-1_200_000), workers: trio },
    { n: 2, startedAt: iso(-1_200_000), endedAt: null, workers: [worker({ agentId: 'w2', task: 4 })] },
  ];
  const three = [
    { n: 1, startedAt: iso(-7_200_000), endedAt: iso(-3_600_000), workers: [mergedWorker({ agentId: 'z', task: 9, title: 'Old' })] },
    ...waves.map((wv) => ({ ...wv, n: wv.n + 1 })),
  ];
  render.renderDetail(root, detail({ waves: three }), { now: NOW, actions: actions() });
  const order = [...root.querySelector('.orch-waves').querySelectorAll('.past-wave')].map((r) => r.querySelector('.wn').textContent);
  assert.deepEqual(order, ['Wave 2', 'Wave 1'], 'earlier waves are newest first');
  render.renderDetail(root, detail({ waves }), { now: NOW, actions: actions() });
  const rows = root.querySelector('.orch-waves').querySelectorAll('.past-wave');
  assert.equal(rows.length, 1);
  const text = rows[0].textContent;
  for (const t of ['T1 Title 1', 'T2 Title 2', 'T3 Title 3']) assert.ok(text.includes(t), t);
  assert.ok(text.includes('Wave 1'));
  assert.ok(text.includes('took 40m'));
  assert.ok(root.querySelector('.orch-waves').textContent.includes('EARLIER WAVES'));
  assert.ok(root.querySelector('.orch-waves').textContent.includes('WAVE 2'));
  assert.ok(root.querySelector('.orch-waves').textContent.includes('20m so far'));
  render.renderDetail(root, detail({ waves: [{ ...waves[0], endedAt: null }, waves[1]] }), { now: NOW + 3000, actions: actions() });
  // The wave ran until the next wave started, so its length still shows.
  assert.ok(root.querySelector('.past-wave').textContent.includes('took 40m'));
  render.renderDetail(root, detail({ waves: [{ ...waves[0], startedAt: null, endedAt: null }, waves[1]] }), { now: NOW + 6000, actions: actions() });
  assert.ok(root.querySelector('.past-wave').textContent.includes('took —'));
});

test('a live run whose last wave is all merged still shows that wave, as merged rows', () => {
  const waves = [{ n: 3, startedAt: iso(-1_200_000), endedAt: iso(-300_000), workers: [mergedWorker({ agentId: 'a' }), mergedWorker({ agentId: 'b', task: 5 })] }];
  render.renderDetail(root, detail({ waves }), { now: NOW, actions: actions() });
  assert.ok(root.querySelector('.orch-waves').textContent.includes('WAVE 3'));
  const cards = [...root.querySelectorAll('.worker')];
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.classList.contains('fin')));
  assert.equal(root.querySelectorAll('.past-wave').length, 0);
});

const pendingSteer = (over = {}) => ({ id: 'r1', state: 'pending', at: iso(-12_000), text: 'Use the cache', ...over });

test('a pending steer shows Pending and a drain line that a poll does not rebuild', () => {
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer() })), { now: NOW, actions: actions() });
  const row = inCard('.w-steer');
  assert.equal(row.hidden, false);
  assert.match(inCard('.state').textContent, /Pending/);
  assert.ok(inCard('.q').textContent.includes('Use the cache'));
  const drain = inCard('.drain');
  assert.ok(drain);
  assert.equal(drain.style.animationDelay, '-12000ms');
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer() })), { now: NOW + 3000, actions: actions() });
  assert.strictEqual(inCard('.drain'), drain);
  assert.equal(drain.style.animationDelay, '-12000ms', 'the delay is set once');
});

test('the drain line works with the epoch-millisecond time the server sends', () => {
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer({ at: NOW - 12_000 }) })), { now: NOW, actions: actions() });
  assert.ok(inCard('.drain'));
});

test('a pending steer 40 s old has no drain line', () => {
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer({ at: iso(-40_000) }) })), { now: NOW, actions: actions() });
  assert.equal(inCard('.drain'), null);
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer() })), { now: NOW + 3000, actions: actions() });
  assert.ok(inCard('.drain'));
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer({ state: 'delivered' }) })), { now: NOW + 6000, actions: actions() });
  assert.equal(inCard('.drain'), null, 'the line goes when the steer leaves pending');
});

test('a failed steer offers Steer again, which opens the composer with the old text', async () => {
  const w = worker({ lastSteer: pendingSteer({ state: 'failed', reason: 'timed out (it may still arrive)', text: 'Use the cache' }) });
  render.renderDetail(root, oneWave(w), { now: NOW, actions: actions() });
  assert.match(inCard('.state').textContent, /Failed/);
  assert.match(inCard('.sub').textContent, /Not confirmed/);
  const again = byText(root.querySelector('.worker'), 'Steer again');
  assert.ok(again);
  await again.click();
  const p = steerParts();
  assert.equal(p.form.hidden, false);
  assert.equal(p.input.value, 'Use the cache');
  assert.ok(p.card.querySelector('.w-compose').classList.contains('open'));
  assert.equal(p.card.querySelector('.cn').textContent, '13 / 2000');
});

test('Steer again is hidden for a delivered steer and when the run is not live', () => {
  render.renderDetail(root, oneWave(worker({ lastSteer: pendingSteer({ state: 'delivered' }) })), { now: NOW, actions: actions() });
  assert.equal(byText(root.querySelector('.worker'), 'Steer again').hidden, true);
  render.renderDetail(root, detail({ live: false, waves: [{ n: 1, workers: [worker({ lastSteer: pendingSteer({ state: 'failed' }) })] }] }), { now: NOW + 3000, actions: actions() });
  assert.equal(byText(root.querySelector('.worker'), 'Steer again').hidden, true);
});

test('the composer counter reads N / 2000 and Send is disabled while empty', async () => {
  render.renderDetail(root, oneWave(worker()), { now: NOW, actions: actions() });
  const p = steerParts();
  await p.open.click();
  assert.equal(p.card.querySelector('.cn').textContent, '0 / 2000');
  assert.equal(p.send.hasAttribute('disabled'), true);
  p.input.value = 'abc';
  await p.input.dispatch('input');
  assert.equal(p.card.querySelector('.cn').textContent, '3 / 2000');
  assert.equal(p.send.hasAttribute('disabled'), false);
  p.input.value = '   ';
  await p.input.dispatch('input');
  assert.equal(p.send.hasAttribute('disabled'), true);
});

test('the counter has the warn class above 1800 characters', async () => {
  render.renderDetail(root, oneWave(worker()), { now: NOW, actions: actions() });
  const p = steerParts();
  await p.open.click();
  p.input.value = 'x'.repeat(1800);
  await p.input.dispatch('input');
  assert.equal(p.card.querySelector('.cn').classList.contains('warn'), false);
  p.input.value = 'x'.repeat(1801);
  await p.input.dispatch('input');
  assert.equal(p.card.querySelector('.cn').classList.contains('warn'), true);
});

test('a working card that merges on the next poll becomes a fin row with no meters', () => {
  render.renderDetail(root, oneWave(worker({ agentId: 'agM', task: 4 })), { now: NOW, actions: actions() });
  assert.ok(inCard('.meters'));
  render.renderDetail(root, oneWave(mergedWorker()), { now: NOW + 3000, actions: actions() });
  const cards = [...root.querySelectorAll('.worker')];
  assert.equal(cards.length, 1);
  assert.ok(cards[0].classList.contains('fin'));
  assert.equal(cards[0].querySelector('.meters'), null);
});

test('an open card lists Done when, each planned file with ● or ○, outside files with !, and the last steps', async () => {
  const w = worker({
    doneWhen: 'The parser passes',
    files: ['lib/a.js', 'lib/b.js'], touched: ['/wt/lib/a.js'], edited: ['/wt/lib/a.js', '/wt/x.js'],
    steps: [{ line: 1, time: iso(-60_000), kind: 'tool', tool: 'Read', text: 'a.js' }, { line: 2, time: iso(-30_000), kind: 'error', tool: 'Bash', text: 'exit 1' }],
  });
  render.renderDetail(root, oneWave(w), { now: NOW, actions: actions() });
  assert.equal(inCard('.w-more').hidden, true);
  await inCard('.chev').click();
  const more = inCard('.w-more');
  assert.equal(more.hidden, false);
  assert.equal(inCard('.chev').getAttribute('aria-expanded'), 'true');
  const t = more.textContent;
  assert.ok(t.includes('Done when') && t.includes('The parser passes'));
  const files = [...more.querySelector('.pf').querySelectorAll('li')].map((li) => li.textContent);
  assert.equal(files.length, 3);
  assert.ok(files[0].startsWith('●') && files[0].includes('lib/a.js'));
  assert.ok(files[1].startsWith('○') && files[1].includes('lib/b.js'));
  assert.ok(files[2].startsWith('!') && files[2].includes('/wt/x.js'));
  const steps = more.querySelector('.steps').querySelectorAll('li');
  assert.equal(steps.length, 2);
  assert.ok(steps[0].textContent.includes('Bash: exit 1'));
});

test('an open merged row shows Final report and Files', async () => {
  render.renderDetail(root, oneWave(mergedWorker()), { now: NOW, actions: actions() });
  assert.equal(inCard('.w-more').hidden, true);
  await inCard('.chev').click();
  const t = inCard('.w-more').textContent;
  assert.equal(inCard('.w-more').hidden, false);
  assert.ok(t.includes('Final report') && t.includes('Everything shipped.'));
  assert.ok(t.includes('Files') && t.includes('e.js'));
  render.renderDetail(root, oneWave(mergedWorker()), { now: NOW + 3000, actions: actions() });
  assert.equal(inCard('.w-more').hidden, false, 'a poll keeps it open');
});

test('a card with no current step reads No tool call yet, and its meta reads review none yet', () => {
  render.renderDetail(root, oneWave(worker({ current: null })), { now: NOW, actions: actions() });
  assert.equal(inCard('.w-tool').querySelector('code').textContent, 'No tool call yet');
  assert.equal(inCard('.w-meta').textContent, 'run 10m · review none yet');
});

test('a steer being sent shows Pending and Sending…', async () => {
  const gate = deferred();
  render.renderDetail(root, oneWave(worker()), { now: NOW, actions: actions({ sendSteer: () => gate.promise }) });
  const p = steerParts();
  await p.open.click();
  p.input.value = 'Use the cache';
  const submitted = p.form.requestSubmit();
  assert.equal(p.send.getAttribute('aria-disabled'), 'true');
  gate.resolve({ ok: true, status: 202, data: { id: 'req1' } });
  await submitted;
  assert.match(steerParts().state.textContent, /Pending/);
  assert.equal(steerParts().status.textContent, 'Sending…');
  assert.ok(steerParts().card.querySelector('.q').textContent.includes('Use the cache'));
  assert.equal(steerParts().card.querySelector('.w-steer').hidden, false);
});

test('the banner Steer button opens the restyled card composer', async () => {
  render.renderDetail(root, oneWave(stuckWorker()), { now: NOW, actions: actions() });
  await byText(banners()[0], 'Steer Task 2').click();
  const card = root.querySelector('.worker');
  assert.equal(card.querySelector('.steer-form').hidden, false);
  assert.ok(card.querySelector('.w-compose').classList.contains('open'));
  assert.equal(document.activeElement, card.querySelector('.steer-form').querySelector('.orch-field'));
  await card.querySelector('.steer-form').querySelector('.orch-field').dispatch('keydown', { key: 'Escape' });
  assert.equal(card.querySelector('.w-compose').classList.contains('open'), false);
});

test('an ended run shows no Steer button on any card', () => {
  const waves = [{ n: 1, workers: [worker({ agentId: 'a' }), stuckWorker({ agentId: 'b' }), worker({ agentId: 'c', status: 'passed' })] }];
  render.renderDetail(root, detail({ live: false, waves }), { now: NOW, actions: actions() });
  const cards = [...root.querySelectorAll('.worker')];
  assert.equal(cards.length, 3);
  for (const card of cards) assert.equal(byText(card, 'Steer').hidden, true);
});

test('a poll keeps the expanded details open when the worker merges', async () => {
  render.renderDetail(root, oneWave(worker({ agentId: 'agM', task: 4 })), { now: NOW, actions: actions() });
  await inCard('.chev').click();
  render.renderDetail(root, oneWave(mergedWorker()), { now: NOW + 3000, actions: actions() });
  assert.equal(inCard('.w-more').hidden, false);
});
