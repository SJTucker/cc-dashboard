'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  labelStep, barSlots, axisScale, tooltipPosition, donutSlices, mixEntries, hourTicks, laneLayout, rebuildMarks, rangeDomain,
  markerKey, markersInDomain, laneKinds, laneCells, pickInCell, resolvePicked, afterDaysSoFar, dateLabelStep, domainDays,
} = require('../public/chart-geometry');

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

test('mixEntries sorts by the chosen measure, largest first', () => {
  const models = [
    { model: 'a', tokens: 10, cost: 5, priced: true },
    { model: 'b', tokens: 30, cost: 1, priced: true },
  ];
  const tokens = mixEntries(models, 'tokens');
  const cost = mixEntries(models, 'cost');
  assert.deepStrictEqual(tokens.shown.map((e) => [e.model, e.value]), [['b', 30], ['a', 10]]);
  assert.deepStrictEqual(cost.shown.map((e) => [e.model, e.value]), [['a', 5], ['b', 1]]);
  assert.strictEqual(tokens.total, 40);
  assert.strictEqual(cost.total, 6);
  assert.deepStrictEqual(models.map((m) => m.model), ['a', 'b'], 'input order unchanged');
});

test('mixEntries lists an unpriced model apart in the cost view only', () => {
  const models = [
    { model: 'a', tokens: 10, cost: 5, priced: true },
    { model: 'x', tokens: 50, cost: 0, priced: false },
  ];
  const cost = mixEntries(models, 'cost');
  assert.deepStrictEqual(cost.shown.map((e) => e.model), ['a']);
  assert.deepStrictEqual(cost.unpriced.map((m) => m.model), ['x']);
  assert.strictEqual(cost.total, 5);
  const tokens = mixEntries(models, 'tokens');
  assert.deepStrictEqual(tokens.shown.map((e) => e.model), ['x', 'a']);
  assert.deepStrictEqual(tokens.unpriced, []);
});

test('mixEntries gives a zero total when every model is unpriced', () => {
  const { shown, unpriced, total } = mixEntries([{ model: 'x', tokens: 5, cost: 0, priced: false }], 'cost');
  assert.deepStrictEqual([shown.length, unpriced.length, total], [0, 1, 0]);
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

const rb = (t, main = true) => ({ t, main, cause: 'expired', reason: null, tokens: 50_000, gapMs: 1, premium: 0.1 });

test('rebuildMarks gives each rebuild its own mark when they are far apart', () => {
  const marks = rebuildMarks([rb(at(10)), rb(at(11))], xOf);
  assert.deepStrictEqual(marks.map((m) => [m.x, m.items.length, m.main]), [[60, 1, true], [120, 1, true]]);
});

test('rebuildMarks joins rebuilds closer than minGapPx into one mark, in time order', () => {
  const late = rb(at(10, 5), false);
  const early = rb(at(10), false);
  const apart = rb(at(10, 20), false);
  const marks = rebuildMarks([late, early, apart], xOf, 8);
  assert.deepStrictEqual(marks.map((m) => [m.x, m.items, m.main]), [[60, [early, late], false], [80, [apart], false]]);
});

test('rebuildMarks gives two rebuilds exactly minGapPx apart two marks', () => {
  const marks = rebuildMarks([rb(at(10)), rb(at(10, 8))], xOf, 8);
  assert.deepStrictEqual(marks.map((m) => m.items.length), [1, 1]);
});

test('rebuildMarks measures the gap from the mark\'s first item, so a chain does not grow without end', () => {
  const marks = rebuildMarks([rb(at(10)), rb(at(10, 5)), rb(at(10, 10))], xOf, 8);
  assert.deepStrictEqual(marks.map((m) => m.items.length), [2, 1]);
});

test('a mark with any main-thread rebuild is main', () => {
  const [mark] = rebuildMarks([rb(at(10), false), rb(at(10, 1), true)], xOf, 8);
  assert.strictEqual(mark.main, true);
});

test('rebuildMarks of no rebuilds is empty', () => {
  assert.deepStrictEqual(rebuildMarks([], xOf), []);
});

test('rangeDomain keeps the end and moves the start back by the given days', () => {
  const day = 24 * 60 * 60 * 1000;
  const full = [0, 100 * day];
  assert.deepStrictEqual(rangeDomain(full, 14), [86 * day, 100 * day]);
  assert.deepStrictEqual(rangeDomain(full, 30), [70 * day, 100 * day]);
  assert.deepStrictEqual(rangeDomain(full, 90), [10 * day, 100 * day]);
});

test('rangeDomain starts at the data start when the range is longer than the data', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.deepStrictEqual(rangeDomain([40 * day, 50 * day], 90), [40 * day, 50 * day]);
});

test('rangeDomain returns the full domain for null', () => {
  const full = [5, 500];
  assert.strictEqual(rangeDomain(full, null), full);
});

test('barSlots keeps every bar inside the plot, with no minimum width', () => {
  for (const n of [1, 7, 30, 190, 400, 2000]) {
    const { x, barWidth } = barSlots(n, 554);
    assert.ok(barWidth > 0, `n=${n}: barWidth is ${barWidth}`);
    assert.ok(x(0) >= 0, `n=${n}: the first bar starts at ${x(0)}`);
    assert.ok(x(n - 1) + barWidth <= 554, `n=${n}: the last bar ends at ${x(n - 1) + barWidth}`);
  }
});

test('barSlots puts bars one step apart with a 3px gap when the step is wide', () => {
  const { step, barWidth, x } = barSlots(7, 554);
  close(step, 554 / 7);
  close(barWidth, 554 / 7 - 3);
  close(x(0), 1.5);
  close(x(3) - x(2), step);
});

test('barSlots keeps three quarters of a narrow step as bar, so a texture shows across a run of bars', () => {
  for (const n of [190, 400, 2000]) {
    const { step, barWidth } = barSlots(n, 554);
    close(barWidth, step * 0.75);
  }
});

test('barSlots with no buckets returns finite numbers', () => {
  const { step, barWidth, x } = barSlots(0, 554);
  assert.ok([step, barWidth, x(0)].every(Number.isFinite));
});

test('axisScale rounds the top up to a whole 1, 2 or 5 step', () => {
  assert.deepStrictEqual(axisScale(100), { step: 50, max: 100 });
  assert.deepStrictEqual(axisScale(452e6), { step: 2e8, max: 6e8 });
  assert.deepStrictEqual(axisScale(1.5), { step: 0.5, max: 1.5 });
  assert.deepStrictEqual(axisScale(0.83), { step: 0.5, max: 1 });
});

test('axisScale treats a max that is not a positive number as 1, so the top is never 0', () => {
  for (const raw of [0, -3, NaN, Infinity, undefined]) {
    assert.deepStrictEqual(axisScale(raw), { step: 0.5, max: 1 }, `rawMax ${raw}`);
  }
});

// Setup changes timeline. Dates are built in local time because the functions group by local day.
const atLocal = (month, day, hour = 12) => new Date(2026, month, day, hour).getTime();
const marker = (t, kind, label = `${kind}@${t}`) => ({ t, kind, label });
const DAY_MS = 24 * 60 * 60 * 1000;

test('markerKey joins the time and the label', () => {
  assert.strictEqual(markerKey({ t: 5, label: 'x' }), '5|x');
});

test('markersInDomain keeps a marker on either edge, drops the rest, and keeps order', () => {
  const domain = [atLocal(9, 1, 0), atLocal(9, 8, 0)];
  const a = marker(domain[0], 'skill');
  const b = marker(atLocal(9, 3), 'hook');
  const c = marker(domain[1], 'rtk');
  const early = marker(domain[0] - 1, 'skill');
  const late = marker(domain[1] + 1, 'skill');
  assert.deepStrictEqual(markersInDomain([early, a, b, c, late], domain), [a, b, c]);
});

test('markersInDomain returns nothing for the domain of an empty report', () => {
  assert.deepStrictEqual(markersInDomain([marker(5, 'skill')], [Infinity, -Infinity]), []);
});

test('laneKinds lists the kinds present in the fixed lane order', () => {
  const ms = [marker(1, 'hook'), marker(2, 'claude-code'), marker(3, 'hook'), marker(4, 'skill'), marker(5, 'effort')];
  assert.deepStrictEqual(laneKinds(ms), ['claude-code', 'skill', 'hook', 'effort']);
  assert.deepStrictEqual(laneKinds([]), []);
});

test('laneKinds puts an unknown kind in the other lane', () => {
  assert.deepStrictEqual(laneKinds([marker(1, 'mystery'), marker(2, 'other')]), ['other']);
});

test('laneCells groups one kind on one day into one cell, oldest marker first', () => {
  const domain = [atLocal(9, 1, 0), atLocal(9, 8, 0)];
  const late = marker(atLocal(9, 2, 18), 'skill', 'late');
  const early = marker(atLocal(9, 2, 8), 'skill', 'early');
  assert.deepStrictEqual(laneCells([late, early], domain, 60), [
    { kind: 'skill', start: atLocal(9, 2, 0), end: atLocal(9, 3, 0), markers: [early, late] },
  ]);
});

test('laneCells makes one cell per kind on a day with several kinds, in lane order', () => {
  const domain = [atLocal(9, 1, 0), atLocal(9, 8, 0)];
  const ms = [marker(atLocal(9, 2, 9), 'hook'), marker(atLocal(9, 2, 10), 'claude-code'), marker(atLocal(9, 2, 11), 'skill')];
  assert.deepStrictEqual(laneCells(ms, domain, 60).map((c) => c.kind), ['claude-code', 'skill', 'hook']);
});

test('laneCells counts a marker exactly on the first domain edge', () => {
  const domain = [atLocal(9, 1, 0), atLocal(9, 8, 0)];
  const edge = marker(domain[0], 'rtk');
  assert.deepStrictEqual(laneCells([edge], domain, 60).map((c) => c.markers), [[edge]]);
});

test('laneCells leaves out a marker outside the domain', () => {
  const domain = [atLocal(9, 1, 0), atLocal(9, 8, 0)];
  assert.deepStrictEqual(laneCells([marker(atLocal(8, 20), 'skill')], domain, 60), []);
});

test('laneCells puts 17 changes of one kind on one day in one cell', () => {
  const domain = [atLocal(8, 28, 0), atLocal(9, 5, 0)];
  const ms = Array.from({ length: 17 }, (_, i) => marker(atLocal(8, 28, 0) + i * 60000, 'claude-code', `v${i}`));
  const cells = laneCells(ms, domain, 60);
  assert.strictEqual(cells.length, 1);
  assert.strictEqual(cells[0].markers.length, 17);
});

test('laneCells groups by Monday week below 16px per day, across a month boundary', () => {
  // Mon 28 Sep, Wed 30 Sep and Fri 2 Oct are one week. Mon 5 Oct starts the next.
  const domain = [atLocal(8, 21, 0), atLocal(9, 12, 0)];
  const wed = marker(atLocal(8, 30), 'skill', 'wed');
  const fri = marker(atLocal(9, 2), 'skill', 'fri');
  const mon = marker(atLocal(9, 5), 'skill', 'mon');
  assert.deepStrictEqual(laneCells([mon, fri, wed], domain, 10), [
    { kind: 'skill', start: atLocal(8, 28, 0), end: atLocal(9, 5, 0), markers: [wed, fri] },
    { kind: 'skill', start: atLocal(9, 5, 0), end: atLocal(9, 12, 0), markers: [mon] },
  ]);
});

test('laneCells groups by day at exactly 16px per day', () => {
  const domain = [atLocal(8, 21, 0), atLocal(9, 12, 0)];
  const ms = [marker(atLocal(8, 30), 'skill'), marker(atLocal(9, 2), 'skill')];
  assert.strictEqual(laneCells(ms, domain, 16).length, 2);
});

test('laneCells puts an unknown kind in the other cell', () => {
  const domain = [atLocal(9, 1, 0), atLocal(9, 8, 0)];
  assert.deepStrictEqual(laneCells([marker(atLocal(9, 2), 'mystery')], domain, 60).map((c) => c.kind), ['other']);
});

test('pickInCell returns the newest marker', () => {
  const a = marker(10, 'skill');
  const b = marker(30, 'skill');
  const c = marker(20, 'skill');
  assert.strictEqual(pickInCell({ markers: [a, b, c] }), b);
});

test('resolvePicked returns the picked marker when it is inside the domain', () => {
  const a = marker(10, 'skill', 'a');
  const b = marker(20, 'skill', 'b');
  assert.strictEqual(resolvePicked([a, b], markerKey(a), [0, 100]), a);
});

test('resolvePicked falls back to the newest marker in the domain when the picked one is outside', () => {
  const old = marker(10, 'skill', 'old');
  const mid = marker(60, 'skill', 'mid');
  const new1 = marker(90, 'hook', 'new');
  assert.strictEqual(resolvePicked([old, mid, new1], markerKey(old), [50, 100]), new1);
});

test('resolvePicked picks the newest marker when nothing is picked', () => {
  const a = marker(10, 'skill', 'a');
  const b = marker(20, 'skill', 'b');
  assert.strictEqual(resolvePicked([b, a], null, [0, 100]), b);
});

test('resolvePicked counts a marker on the domain edge and returns null when none is inside', () => {
  const edge = marker(100, 'skill', 'edge');
  assert.strictEqual(resolvePicked([edge], markerKey(edge), [0, 100]), edge);
  assert.strictEqual(resolvePicked([edge], markerKey(edge), [200, 300]), null);
  assert.strictEqual(resolvePicked([], null, [0, 100]), null);
  assert.strictEqual(resolvePicked([edge], null, [Infinity, -Infinity]), null);
});

test('afterDaysSoFar counts whole and part days since the change, up to 7', () => {
  assert.strictEqual(afterDaysSoFar(0, 0), 0);
  assert.strictEqual(afterDaysSoFar(0, 1), 1);
  assert.strictEqual(afterDaysSoFar(0, 3.2 * DAY_MS), 4);
  assert.strictEqual(afterDaysSoFar(0, 6 * DAY_MS), 6);
  assert.strictEqual(afterDaysSoFar(0, 7.5 * DAY_MS), 7);
  assert.strictEqual(afterDaysSoFar(0, 30 * DAY_MS), 7);
  assert.strictEqual(afterDaysSoFar(10, 0), 0);
});

test('dateLabelStep labels every day from 28px and Mondays below', () => {
  assert.strictEqual(dateLabelStep(63), 'day');
  assert.strictEqual(dateLabelStep(28), 'day');
  assert.strictEqual(dateLabelStep(27.9), 'monday');
  assert.strictEqual(dateLabelStep(3), 'monday');
});

test('domainDays lists the local noon of each day inside the domain', () => {
  assert.deepStrictEqual(domainDays([atLocal(9, 1, 0), atLocal(9, 4, 0)]), [atLocal(9, 1), atLocal(9, 2), atLocal(9, 3)]);
  assert.deepStrictEqual(domainDays([atLocal(9, 1, 12), atLocal(9, 2, 12)]), [atLocal(9, 1), atLocal(9, 2)]);
  assert.deepStrictEqual(domainDays([atLocal(9, 1, 13), atLocal(9, 2, 13)]), [atLocal(9, 2)]);
  assert.deepStrictEqual(domainDays([Infinity, -Infinity]), []);
});
