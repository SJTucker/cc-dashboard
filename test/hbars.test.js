'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/charts/hbars.mjs');

test('barRows sizes each bar as a percent of scaleMax and keeps the value text', async () => {
  const { barRows } = await load();
  const rows = [{ name: 'Read', calls: 50 }, { name: 'Bash', calls: 25 }];
  assert.deepStrictEqual(
    barRows(rows, { size: (r) => r.calls, scaleMax: 50, value: (r) => `${r.calls}` }),
    [
      { name: 'Read', label: 'Read', left: 0, width: 100, value: '50' },
      { name: 'Bash', label: 'Bash', left: 0, width: 50, value: '25' },
    ]
  );
});

test('barRows puts zero inside the track when scaleMin is negative', async () => {
  const { barRows } = await load();
  const rows = [{ name: 'read', kept: 300 }, { name: 'tsc', kept: -100 }];
  // The track spans -100..300, so zero sits 25% in.
  assert.deepStrictEqual(
    barRows(rows, { size: (r) => r.kept, scaleMax: 300, scaleMin: -100, value: (r) => `${r.kept}` }),
    [
      { name: 'read', label: 'read', left: 25, width: 75, value: '300' },
      { name: 'tsc', label: 'tsc', left: 0, width: 25, value: '-100' },
    ]
  );
});

test('barRows on an all-negative list draws every bar leftward from the right end', async () => {
  const { barRows } = await load();
  const [a, b] = barRows([{ name: 'a', v: -50 }, { name: 'b', v: -100 }], {
    size: (r) => r.v, scaleMax: 0, scaleMin: -100, value: () => '',
  });
  assert.deepStrictEqual([a.left, a.width], [50, 50]);
  assert.deepStrictEqual([b.left, b.width], [0, 100]);
});

test('barRows draws no bar length when scaleMax is 0', async () => {
  const { barRows } = await load();
  const [row] = barRows([{ name: 'x', cost: 0 }], { size: (r) => r.cost, scaleMax: 0, value: () => '0.0%' });
  assert.equal(row.width, 0);
});

test('barRows uses the label function for the name cell and keeps the full name', async () => {
  const { barRows } = await load();
  const [row] = barRows([{ name: '/a/b/file.js', calls: 1 }], {
    size: (r) => r.calls, scaleMax: 1, value: () => '1', label: (r) => r.name.split('/').pop(),
  });
  assert.equal(row.label, 'file.js');
  assert.equal(row.name, '/a/b/file.js');
});
