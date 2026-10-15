'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

installDom();
// hideTooltip looks up #tooltip, which the stub does not have.
globalThis.document.getElementById = () => ({ hidden: true });
const load = () => import('../public/charts/mirror-line.mjs');

const series = (overrides) => ({
  key: '/r/a', label: 'a', color: '#3987e5', dash: null, added: [5, 0, 3], removed: [1, 2, 0],
  totalAdded: 8, totalRemoved: 3, members: [], ...overrides,
});
const container = () => {
  const node = document.createElement('div');
  node.clientWidth = 600;
  return node;
};
const find = (node, tag) => [node, ...node.children.flatMap((c) => find(c, tag))].filter((n) => n.tagName === tag);

test('drawMirroredLineChart draws an added and a removed path per series, with no end labels', async () => {
  const { drawMirroredLineChart } = await load();
  const node = container();
  drawMirroredLineChart(node, ['2026-10-13', '2026-10-14', '2026-10-15'], [series(), series({ key: 'other', label: 'Other', dash: '14 4' })]);

  const paths = find(node, 'path');
  assert.strictEqual(paths.length, 4);
  assert.strictEqual(paths[2].getAttribute('stroke-dasharray'), '14 4');
});

test('drawMirroredLineChart draws a dot per value on a one-day range', async () => {
  const { drawMirroredLineChart } = await load();
  const node = container();
  drawMirroredLineChart(node, ['2026-10-15'], [series({ added: [4], removed: [2] })]);
  assert.strictEqual(find(node, 'circle').length, 2);
});

test('drawMirroredLineChart shows the empty text when there are no series', async () => {
  const { drawMirroredLineChart } = await load();
  const node = container();
  drawMirroredLineChart(node, ['2026-10-15'], []);
  assert.strictEqual(node.textContent, 'No edits in this range.');
});

test('drawLinesLegend lists each series with its totals, and Other names its repos on hover', async () => {
  const { drawLinesLegend } = await load();
  const node = container();
  drawLinesLegend(node, [series({ totalAdded: 1240 }), series({ key: 'other', label: 'Other', members: ['b', 'c'] })]);
  const items = node.children[0].children;
  assert.strictEqual(items[0].textContent, 'a+1,240 / −3');
  assert.strictEqual(items[0].getAttribute('title'), null);
  assert.strictEqual(items[1].getAttribute('title'), 'b, c');
});

test('drawMirroredLineChart labels the zero line, added above it and deleted below it', async () => {
  const { drawMirroredLineChart } = await load();
  const node = container();
  drawMirroredLineChart(node, ['2026-10-13', '2026-10-14', '2026-10-15'], [series()]);
  const texts = find(node, 'text');
  const named = (s) => texts.find((n) => n.textContent === s);
  const zero = named('0');
  const added = named('added');
  const deleted = named('deleted');
  assert.ok(zero && added && deleted);
  const zeroY = Number(zero.getAttribute('y')) - 3;
  assert.ok(Number(added.getAttribute('y')) < zeroY);
  assert.ok(Number(deleted.getAttribute('y')) > zeroY);
  assert.strictEqual(added.getAttribute('text-anchor'), 'start');
});
