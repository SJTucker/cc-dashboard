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
  assert.equal(root.querySelector('.orch-topic').textContent, '');
  assert.equal(root.querySelector('.orch-waves').children.length, 0);
  assert.equal(root.querySelector('.feed').children.length, 0);
  assert.equal(root.querySelector('.board-list').children.length, 0);
  // A wave with no workers array renders too.
  render.renderDetail(root, { id: 'x', live: true, phase: 'waves', waves: [{ n: 1 }] }, { now: NOW, actions: actions() });
  assert.equal(root.querySelector('.orch-waves').children.length, 1);
  assert.equal(root.querySelector('.orch-waves').children[0].querySelector('.chips').children.length, 0);
  assert.equal(root.querySelector('.orch-empty').hidden, true);
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
  assert.equal(card.querySelector('.w-foot').textContent.includes('NaN'), false);
  assert.match(card.querySelector('.w-foot').textContent, /Running —/);
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
      status: card.querySelector('.status'),
      foot: card.querySelector('.w-foot'),
      slot: card.querySelector('.w-slot'),
      steps: card.querySelector('.steps'),
    };
  };
  const before = pick();
  const footText = before.foot.textContent;
  const actText = before.card.querySelector('.act').textContent;
  render.renderDetail(root, detail(), { now: NOW + 3000, actions: actions() });
  const same = pick();
  for (const key of Object.keys(before)) assert.strictEqual(same[key], before[key], key);

  // Open the card so the step rows exist, then change one worker.
  before.card.querySelector('.w-head').click();
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
  assert.equal(after.card.querySelector('.act').textContent, actText);
  assert.equal(after.title.textContent, 'T1Add the parser');
  const rows = [...after.steps.children];
  assert.equal(rows.length, 2);
  assert.ok(rows.includes(rowsBefore[0]), 'the existing step row is reused');
});

// ---------- Composers ----------

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const byText = (node, text) => node.querySelectorAll('.orch-btn').find((b) => b.textContent === text);
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
    status: card.querySelector('.steer-status'),
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
  assert.equal(steerParts().status.textContent, 'Sending…');
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
