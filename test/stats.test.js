'use strict';

const test = require('node:test');
const { before } = test;
const assert = require('node:assert');
let dayTotals, rollingWeek;
before(async () => { ({ dayTotals, rollingWeek } = await import('../public/stats.mjs')); });

function day(date, over = {}) {
  return { date, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, byModel: {}, costByModel: {}, ...over };
}

test('dayTotals sums hour-keyed entries into their day, sorted by date', () => {
  const rows = [
    day('2026-03-05T14', { input: 1, output: 2, cacheCreate: 3, cacheRead: 4, cost: 0.5 }),
    day('2026-03-04', { input: 10, cost: 1 }),
    day('2026-03-05T09', { output: 5, cost: 0.25 }),
  ];
  assert.deepStrictEqual(dayTotals(rows), [
    { date: '2026-03-04', tokens: 10, cost: 1 },
    { date: '2026-03-05', tokens: 15, cost: 0.75 },
  ]);
  assert.deepStrictEqual(dayTotals([]), []);
});

test('rollingWeek adds today to the 6 days before it and nothing else', () => {
  const prior = [
    { date: '2026-03-01', tokens: 1000, cost: 100 }, // 7 days back: outside
    { date: '2026-03-02', tokens: 1, cost: 1 },      // 6 days back: inside
    { date: '2026-03-07', tokens: 2, cost: 2 },      // yesterday: inside
    { date: '2026-03-08', tokens: 500, cost: 50 },   // today: already in `today`
  ];
  assert.deepStrictEqual(rollingWeek(prior, '2026-03-08', { cost: 10, tokens: 20 }), { cost: 13, tokens: 23 });
});

test('rollingWeek counts calendar days across a daylight saving change', () => {
  // US clocks go forward on 2026-03-08, so that week has a 23h day.
  const prior = [{ date: '2026-03-04', tokens: 1, cost: 1 }, { date: '2026-03-03', tokens: 9, cost: 9 }];
  assert.deepStrictEqual(rollingWeek(prior, '2026-03-10', { cost: 0, tokens: 0 }), { cost: 1, tokens: 1 });
});

test('rollingWeek returns null while the prior days have not arrived', () => {
  assert.strictEqual(rollingWeek(null, '2026-03-08', { cost: 1, tokens: 1 }), null);
});
