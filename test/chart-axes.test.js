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

test('plotTicks starts at 0 on the baseline and leaves room above the data', async () => {
  const { plotTicks } = await load();
  // 100 * 1.12 = 112, so axisScale gives { step: 50, max: 150 }. The plot is 170px high from y = 6.
  const { max, ticks } = plotTicks(100, { top: 6, plotHeight: 170 });
  assert.equal(max, 150);
  assert.deepStrictEqual(ticks.map((t) => t.value), [0, 50, 100, 150]);
  assert.equal(ticks[0].y, 176);
  assert.equal(ticks[3].y, 6);
});

test('plotTicks on an all-zero range has a top above zero and finite ticks', async () => {
  const { plotTicks } = await load();
  const { max, ticks } = plotTicks(0, { top: 6, plotHeight: 170 });
  assert.equal(max, 1);
  assert.deepStrictEqual(ticks.map((t) => t.value), [0, 0.5, 1]);
  assert.ok(ticks.every((t) => Number.isFinite(t.y)));
});

test('signedTicks uses one step on both sides of zero', async () => {
  const { signedTicks } = await load();
  // axisScale(150) has a step of 50: two steps up to 100, one down to -50, over a 160px plot.
  const { zeroY, yOf, ticks } = signedTicks(-50, 100);
  assert.ok(Math.abs(zeroY - 320 / 3) < 1e-9);
  assert.deepStrictEqual(ticks.map((t) => t.value), [-50, 50, 100]);
  assert.equal(yOf(-50), 160);
  assert.equal(yOf(100), 0);
});

test('signedTicks with no positive value puts zero at the top and no tick above it', async () => {
  const { signedTicks } = await load();
  const { zeroY, ticks } = signedTicks(-300, 0);
  assert.equal(zeroY, 0);
  assert.deepStrictEqual(ticks.map((t) => t.value), [-300, -200, -100]);
  assert.equal(ticks[0].y, 160);
});
