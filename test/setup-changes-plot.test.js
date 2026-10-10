'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/charts/setup-changes.mjs');

test('plotY keeps a negative value on the baseline and a value above max at the top', async () => {
  const { plotY } = await load();
  const g = { bottom: 200, plotHeight: 100, max: 1 };
  assert.equal(plotY(0.5, g), 150);
  assert.equal(plotY(-0.2, g), 200, 'a negative share draws at the baseline, not into the lanes below');
  assert.equal(plotY(3, g), 100);
});
