'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

installDom();
const load = () => import('../public/charts/legend.mjs');

test('legendRow builds one item per entry with its label, value and title', async () => {
  const { legendRow, swatchIcon } = await load();
  const row = legendRow([
    { icon: swatchIcon('solid', '#6b86ad'), label: 'Main thread', value: '93.5%' },
    { icon: swatchIcon('diag', '#6b86ad'), label: 'Subagents', title: 'Calls made inside subagents' },
  ]);
  assert.equal(row.className, 'legend');
  assert.equal(row.children.length, 2);
  const [a, b] = row.children;
  assert.equal(a.className, 'legend-item');
  assert.equal(a.textContent, 'Main thread93.5%');
  assert.equal(a.getAttribute('title'), null);
  assert.equal(b.getAttribute('title'), 'Calls made inside subagents');
  assert.equal(b.children.length, 2, 'an item with no value has no value span');
});

test('legendRow with no items is an empty legend', async () => {
  const { legendRow } = await load();
  assert.equal(legendRow([]).children.length, 0);
});

test('legendRow adds extra classes after legend', async () => {
  const { legendRow } = await load();
  assert.equal(legendRow([], 'side-legend').className, 'legend side-legend');
});

test('swatchIcon paints the texture the charts use', async () => {
  const { swatchIcon } = await load();
  const { textureCss } = await import('../public/charts/palette.mjs');
  assert.equal(swatchIcon('diag', '#6b86ad').getAttribute('style'), `background:${textureCss('diag', '#6b86ad')}`);
});

test('lineIcon carries the series dash, and a solid series has none', async () => {
  const { lineIcon } = await load();
  assert.equal(lineIcon('#d55181', '9 4 2 4').children[0].getAttribute('stroke-dasharray'), '9 4 2 4');
  assert.equal(lineIcon('#9085e9', null).children[0].getAttribute('stroke-dasharray'), null);
});
