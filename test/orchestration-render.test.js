'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/orchestration/render.mjs');

test('statusView gives every status a glyph and a word', async () => {
  const { statusView } = await load();
  for (const s of ['working', 'quiet', 'starting', 'stuck', 'done', 'review', 'passed', 'changes', 'merged']) {
    const v = statusView(s);
    assert.ok(v.glyph && v.word, s);
  }
  assert.equal(statusView('stuck').tone, 'warn');
  assert.equal(statusView('working').tone, 'live');
  assert.equal(statusView('merged').tone, 'plain');
});

test('switcherState words follow waiting, phase and liveness', async () => {
  const { switcherState } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(switcherState({ waiting: true, phase: 'waves', wave: 2, live: true }, now), 'Waiting for you');
  assert.equal(switcherState({ waiting: false, phase: 'waves', wave: 2, live: true }, now), 'Wave 2');
  assert.equal(switcherState({ phase: 'plan', live: true }, now), 'Planning');
  assert.equal(switcherState({ phase: 'reset', live: true }, now), 'Reset');
  assert.equal(switcherState({ phase: 'finish', live: false, lastActiveAt: now - 3 * 3600_000 }, now).startsWith('Finished '), true);
});

test('meterRatio is tokens over the 120000 budget, clamped to 1', async () => {
  const { meterRatio } = await load();
  assert.equal(meterRatio(60000), 0.5);
  assert.equal(meterRatio(130000), 1);
  assert.equal(meterRatio(null), 0);
});

test('phaseSteps marks earlier steps done and the current one now', async () => {
  const { phaseSteps } = await load();
  assert.deepEqual(phaseSteps('waves', true).map((s) => s.state), ['done', 'done', 'now', 'todo']);
  assert.deepEqual(phaseSteps('finish', false).map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(phaseSteps('plan', true).map((s) => s.name), ['Plan', 'Reset', 'Waves', 'Finish']);
});

test('countsLine lists only the non-zero counts', async () => {
  const { countsLine } = await load();
  assert.equal(countsLine({ working: 2, review: 0, merged: 1, attention: 0 }), '2 working · 1 merged');
  assert.equal(countsLine({ working: 0, review: 0, merged: 0, attention: 0 }), 'no workers yet');
});
