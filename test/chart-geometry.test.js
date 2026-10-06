'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { labelStep, tooltipPosition, donutSlices } = require('../public/chart-geometry');

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

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('donutSlices starts at 12 o\'clock and goes clockwise', () => {
  const [a, b] = donutSlices([1, 1], 100, 100, 96, 62);
  close(a.start, 0);
  close(a.end, Math.PI);
  close(b.start, Math.PI);
  close(b.end, 2 * Math.PI);
  assert.strictEqual(a.fraction, 0.5);
  // First slice: outer arc from the top (100,4) to the bottom (100,196), then the
  // inner arc back from (100,162) to (100,38).
  assert.strictEqual(a.d, 'M 100 4 A 96 96 0 0 1 100 196 L 100 162 A 62 62 0 0 0 100 38 Z');
});

test('donutSlices gives a quarter slice a quarter-turn end point', () => {
  const [q] = donutSlices([1, 3], 100, 100, 96, 62);
  close(q.end, Math.PI / 2);
  assert.strictEqual(q.fraction, 0.25);
  assert.match(q.d, /^M 100 4 A 96 96 0 0 1 196 100 L 162 100 A 62 62 0 0 0 100 38 Z$/);
});

test('donutSlices sets the large-arc flag only for a slice over half', () => {
  const [big, small] = donutSlices([3, 1], 100, 100, 96, 62);
  assert.match(big.d, /A 96 96 0 1 1 /);
  assert.match(big.d, /A 62 62 0 1 0 /);
  assert.match(small.d, /A 96 96 0 0 1 /);
  const [half] = donutSlices([1, 1], 100, 100, 96, 62);
  assert.match(half.d, /A 96 96 0 0 1 /);
});

test('donutSlices marks a single non-zero value as a full ring', () => {
  assert.deepStrictEqual(donutSlices([5], 100, 100, 96, 62), [{ full: true, fraction: 1 }]);
  assert.deepStrictEqual(donutSlices([0, 5, 0], 100, 100, 96, 62), [
    { fraction: 0 }, { full: true, fraction: 1 }, { fraction: 0 },
  ]);
});

test('donutSlices skips zero values without moving the next slice', () => {
  const [a, zero, b] = donutSlices([1, 0, 1], 100, 100, 96, 62);
  assert.deepStrictEqual(zero, { fraction: 0 });
  close(a.end, Math.PI);
  close(b.start, Math.PI);
});

test('donutSlices returns [] for empty input or a zero total', () => {
  assert.deepStrictEqual(donutSlices([], 100, 100, 96, 62), []);
  assert.deepStrictEqual(donutSlices([0, 0], 100, 100, 96, 62), []);
});
