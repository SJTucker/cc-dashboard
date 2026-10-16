'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

test('state starts on the Today range with nothing hidden', async () => {
  const { state } = await import('../public/state.mjs');
  assert.equal(state.currentDays, 'today');
  assert.equal(state.tab, 'now');
  assert.equal(state.analysisDays, 'today');
  assert.deepStrictEqual([...state.hiddenKeys], []);
});

test('shown is false only for a key in state.hiddenKeys', async () => {
  const { state, shown } = await import('../public/state.mjs');
  state.hiddenKeys = new Set(['tools']);
  assert.equal(shown('tools'), false);
  assert.equal(shown('dailyCost'), true);
  state.hiddenKeys = new Set();
});
