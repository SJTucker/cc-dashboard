'use strict';

// Pinned so the daylight saving test runs in a zone that has a change. In UTC,
// subtracting N * 24h from today's midnight also lands on midnight, so that test
// would pass on a broken rule. node --test runs each file in its own process, so
// this does not reach other test files.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert');
const { windowStart } = require('../lib/window');

const NOW = new Date(2026, 8, 30, 15, 42, 7).getTime();

test("windowStart('today') is local midnight of now", () => {
  assert.strictEqual(windowStart('today', NOW), new Date(2026, 8, 30).getTime());
});

test('windowStart(7) is local midnight six days before now', () => {
  assert.strictEqual(windowStart(7, NOW), new Date(2026, 8, 24).getTime());
});

test('windowStart(1) is the same as today', () => {
  assert.strictEqual(windowStart(1, NOW), windowStart('today', NOW));
});

test('windowStart(null) has no start', () => {
  assert.strictEqual(windowStart(null, NOW), null);
});

test('windowStart stays on midnight across a daylight saving change', () => {
  // US clocks go back on 2026-11-01 and EU clocks on 2026-10-25. A 30-day window
  // ending 2026-11-03 crosses both, so this checks the rule in either zone.
  const start = new Date(windowStart(30, new Date(2026, 10, 3, 12).getTime()));
  assert.deepStrictEqual([start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()], [9, 5, 0, 0]);
});

test('windowStart throws on a day count that is not a positive whole number', () => {
  for (const days of [0, -3, 1.5, NaN, '7', 'abc']) {
    assert.throws(() => windowStart(days, NOW), TypeError, `days = ${String(days)}`);
  }
});
