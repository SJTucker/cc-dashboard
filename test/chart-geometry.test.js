'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { labelStep, tooltipPosition } = require('../public/chart-geometry');

test('labelStep keeps at most 12 labels on a wide chart', () => {
  assert.strictEqual(labelStep(24, 800), 2);
  assert.strictEqual(labelStep(90, 800), 8);
  assert.strictEqual(labelStep(5, 800), 1);
});

test('labelStep spaces labels at least 44px apart on a narrow chart', () => {
  assert.strictEqual(labelStep(24, 284), 4);
  assert.strictEqual(labelStep(10, 20), 10);
});

test('tooltipPosition puts the tooltip 14px below and right of the pointer', () => {
  assert.deepStrictEqual(tooltipPosition(100, 100, 50, 20, 390, 844), { left: 114, top: 114 });
});

test('tooltipPosition flips left at the right edge and up at the bottom edge', () => {
  assert.deepStrictEqual(tooltipPosition(356, 100, 137, 20, 390, 844), { left: 205, top: 114 });
  assert.deepStrictEqual(tooltipPosition(100, 830, 50, 40, 390, 844), { left: 114, top: 776 });
});

test('tooltipPosition never starts off the left or top edge', () => {
  assert.deepStrictEqual(tooltipPosition(100, 10, 500, 900, 390, 844), { left: 0, top: 0 });
});
