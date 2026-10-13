'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

installDom();

test('drawShareBar draws a segment per item and a legend with each share', async () => {
  const { drawShareBar } = await import('../public/charts/split.mjs');
  const container = document.createElement('div');
  drawShareBar(container, [
    { name: 'Opus 5.5', value: 3, texture: 'dots', color: '#d55181', tooltip: 'a' },
    { name: 'Sonnet 5.5', value: 1, texture: 'solid', color: '#9085e9', tooltip: 'b' },
  ], { empty: 'none' });
  const [bar, legend] = container.children;
  assert.equal(bar.className, 'mix-bar');
  assert.match(bar.children[0].getAttribute('style'), /^width:75%;/);
  assert.deepStrictEqual(legend.children.map((item) => item.textContent), ['Opus 5.575.0%', 'Sonnet 5.525.0%']);
});

test('drawShareBar shows the empty text when the total is zero', async () => {
  const { drawShareBar } = await import('../public/charts/split.mjs');
  const container = document.createElement('div');
  drawShareBar(container, [{ name: 'x', value: 0, texture: 'solid', color: '#000000', tooltip: '' }], { empty: 'Nothing here.' });
  assert.equal(container.textContent, 'Nothing here.');
});

test('drawShareBar appends extra legend items after the shares', async () => {
  const { drawShareBar } = await import('../public/charts/split.mjs');
  const { swatchIcon } = await import('../public/charts/legend.mjs');
  const container = document.createElement('div');
  drawShareBar(container, [{ name: 'a', value: 1, texture: 'solid', color: '#000000', tooltip: '' }], {
    empty: '', extra: [{ icon: swatchIcon('solid', '#5c6779'), label: 'mystery', value: 'unpriced' }],
  });
  assert.equal(container.children[1].children[1].textContent, 'mysteryunpriced');
});
