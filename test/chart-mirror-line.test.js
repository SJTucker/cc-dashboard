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

test('spreadLabels keeps order by y and pushes overlapping labels apart', async () => {
  const { spreadLabels } = await load();
  assert.deepStrictEqual(spreadLabels([50, 52, 20]), [50, 61, 20]);
  assert.deepStrictEqual(spreadLabels([2]), [8], 'a label is never above the top');
});

test('drawMirroredLineChart draws an added and a removed path per series, and one end label each', async () => {
  const { drawMirroredLineChart } = await load();
  const node = container();
  drawMirroredLineChart(node, ['2026-10-13', '2026-10-14', '2026-10-15'], [series(), series({ key: 'other', label: 'Other', dash: '14 4' })]);

  const paths = find(node, 'path');
  assert.strictEqual(paths.length, 4);
  assert.strictEqual(paths[2].getAttribute('stroke-dasharray'), '14 4');
  const labels = find(node, 'text').filter((n) => n.getAttribute('class').includes('line-end-label'));
  assert.deepStrictEqual(labels.map((n) => n.textContent), ['a', 'Other']);
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
