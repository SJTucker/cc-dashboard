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
      { name: 'Read', label: 'Read', width: 100, value: '50' },
      { name: 'Bash', label: 'Bash', width: 50, value: '25' },
    ]
  );
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
