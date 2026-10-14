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

test('plotRawMax on the Session start row is at least the before and after medians', async () => {
  const { plotRawMax } = await load();
  const row = { key: 'sessionStart' };
  const inView = [10, 20, 30, 40].map((context) => ({ context }));
  assert.ok(plotRawMax(row, [], null, inView) < 45);
  assert.equal(plotRawMax(row, [], { before: 60, after: 12 }, inView), 60, 'a before median above the p95 raises the max');
  assert.equal(plotRawMax(row, [], { before: null, after: 70 }, inView), 70);
});
