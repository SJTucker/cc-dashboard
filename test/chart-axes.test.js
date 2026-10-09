'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// index.html loads chart-geometry.js as a classic script, which makes axisScale a
// global that axes.mjs reads. The test sets the same global.
globalThis.axisScale = require('../public/chart-geometry.js').axisScale;
const load = () => import('../public/charts/axes.mjs');

test('yTicks places one tick per step from the first step up to the top', async () => {
  const { yTicks } = await load();
  // axisScale(100) is { step: 50, max: 100 }; the plot is 160px high.
  assert.deepStrictEqual(yTicks(100), { max: 100, ticks: [{ value: 50, y: 80 }, { value: 100, y: 0 }] });
});

test('yTicks on an all-zero range still has a top above zero and finite ticks', async () => {
  const { yTicks } = await load();
  const { max, ticks } = yTicks(0);
  assert.equal(max, 1);
  assert.deepStrictEqual(ticks.map((t) => t.value), [0.5, 1]);
  assert.ok(ticks.every((t) => Number.isFinite(t.y)));
});

test('yTicks keeps a tick at the top when the step does not divide exactly in floating point', async () => {
  const { yTicks } = await load();
  // axisScale(1.5) is { step: 0.5, max: 1.5 }.
  const { ticks } = yTicks(1.5);
  assert.deepStrictEqual(ticks.map((t) => t.value), [0.5, 1, 1.5]);
  assert.equal(ticks[2].y, 0);
});
