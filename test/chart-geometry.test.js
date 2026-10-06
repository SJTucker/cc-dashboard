'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { labelStep, tooltipPosition, donutSlices, hourTicks, laneLayout } = require('../public/chart-geometry');

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

const at = (h, m = 0) => new Date(2026, 9, 6, h, m).getTime();

test('hourTicks runs from the start rounded down to the end rounded up', () => {
  assert.deepStrictEqual(hourTicks(at(9, 30), at(11, 10)), [at(9), at(10), at(11), at(12)]);
});

test('hourTicks keeps an end that falls on the hour', () => {
  assert.deepStrictEqual(hourTicks(at(9, 30), at(11)), [at(9), at(10), at(11)]);
});

test('hourTicks returns two ticks when start and end are in one hour or equal', () => {
  assert.deepStrictEqual(hourTicks(at(9, 5), at(9, 40)), [at(9), at(10)]);
  assert.deepStrictEqual(hourTicks(at(9), at(9)), [at(9), at(10)]);
});

// A scale of 1 px per minute, starting at 09:00.
const xOf = (t) => (t - at(9)) / 60_000;
const NOW_T = at(12);
const lane = (spans, live = false) => ({ spans, live });

test('laneLayout orders lanes by first span start and drops sessions with no span', () => {
  const late = lane([[at(11), at(11, 30)]]);
  const early = lane([[at(9, 10), at(9, 20)]]);
  const none = lane([]);
  const result = laneLayout([late, none, early], xOf, NOW_T);
  assert.deepStrictEqual(result.map((l) => [l.session, l.lane]), [[early, 0], [late, 1]]);
});

test('laneLayout gives each bar its x and width, with a minimum width', () => {
  const s = lane([[at(10), at(10, 30)], [at(11), at(11)]]);
  const [{ bars }] = laneLayout([s], xOf, NOW_T);
  assert.deepStrictEqual(bars.map((b) => [b.x, b.width]), [[60, 30], [120, 3]]);
  assert.deepStrictEqual(laneLayout([s], xOf, NOW_T, 5)[0].bars.map((b) => b.width), [30, 5]);
});

test('laneLayout runs a live session\'s last span to now and marks it open', () => {
  const s = lane([[at(9), at(9, 10)], [at(11, 55), at(11, 58)]], true);
  const [{ bars }] = laneLayout([s], xOf, NOW_T);
  assert.deepStrictEqual(bars.map((b) => b.open), [false, true]);
  assert.strictEqual(bars[1].end, NOW_T);
  assert.strictEqual(bars[1].width, 5);
});

test('laneLayout does not stretch a live session whose last call is older than the live window', () => {
  // live is true because the transcript was written recently, but the last call was 30 minutes ago.
  const s = lane([[at(11, 0), at(11, 30)]], true);
  const [{ bars }] = laneLayout([s], xOf, NOW_T);
  assert.strictEqual(bars[0].open, false);
  assert.strictEqual(bars[0].end, at(11, 30));
});

test('laneLayout never opens the bar of a session that is not live', () => {
  const [{ bars }] = laneLayout([lane([[at(11, 55), at(11, 58)]], false)], xOf, NOW_T);
  assert.strictEqual(bars[0].open, false);
});
