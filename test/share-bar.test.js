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

test('drawSplitBar draws the first row solid on the left and the second dim on the right, whatever their size', async () => {
  const { drawSplitBar } = await import('../public/charts/split.mjs');
  for (const [under, over] of [[1, 9], [9, 1]]) {
    const container = document.createElement('div');
    drawSplitBar(container, [{ name: 'Under', cost: under }, { name: 'Over', cost: over }]);
    const [bar, legend] = container.children;
    assert.deepEqual([...legend.children].map((item) => item.children[1].textContent.startsWith('Under')), [true, false]);
    // Solid accent cyan (#3fe0ff) first, dim cyan (#257991) stripes second, on the bar and in the legend.
    assert.match(bar.children[0].getAttribute('style'), /background:\s*(#3fe0ff|rgb\(63, 224, 255\))\s*;?/i);
    assert.match(bar.children[1].getAttribute('style'), /repeating-linear-gradient.*(257991|37, 121, 145)/i);
    assert.match(legend.children[1].children[0].getAttribute('style'), /257991|37, 121, 145/i);
  }
});
