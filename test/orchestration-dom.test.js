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
  assert.equal(root.querySelector('.panel-meta') !== null, true);
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
  render.renderDetail(root, changed, { now: NOW + 6000, actions: actions() });
  const after = pick();
  for (const key of Object.keys(before)) assert.strictEqual(after[key], before[key], key);
  assert.notEqual(after.status.textContent, statusText);
  assert.match(after.status.textContent, /Stuck/);
  assert.equal(after.title.textContent, 'T1Add the parser');
  const rows = [...after.steps.children];
  assert.equal(rows.length, 2);
  assert.ok(rows.includes(rowsBefore[0]), 'the existing step row is reused');
});
