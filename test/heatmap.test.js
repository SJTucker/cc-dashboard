'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/charts/heatmap.mjs');

test('heatAlpha floors a non-zero cell at 0.12 and gives an idle one 0', async () => {
  const { heatAlpha } = await load();
  assert.equal(heatAlpha(0, 10), 0);
  assert.ok(Math.abs(heatAlpha(10, 10) - 1) < 1e-9);
  assert.ok(heatAlpha(0.0001, 10) > 0.12);
});

test('heatScale spans the cheapest non-zero cell to the busiest in five rising steps', async () => {
  const { heatScale, heatAlpha } = await load();
  const scale = heatScale([0, 1, 4, 2]);
  assert.equal(scale.low, 1);
  assert.equal(scale.high, 4);
  assert.equal(scale.alphas.length, 5);
  assert.ok(Math.abs(scale.alphas[0] - heatAlpha(1, 4)) < 1e-9);
  assert.ok(Math.abs(scale.alphas[4] - 1) < 1e-9);
  for (let i = 1; i < 5; i++) assert.ok(scale.alphas[i] > scale.alphas[i - 1]);
});

test('heatScale is null when nothing cost anything', async () => {
  const { heatScale } = await load();
  assert.equal(heatScale([0, 0]), null);
});
