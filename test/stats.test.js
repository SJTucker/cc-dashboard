'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { busiestDay } = require('../public/stats.js');

function day(date, over = {}) {
  return { date, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, byModel: {}, costByModel: {}, ...over };
}

test('busiestDay returns null for an empty array', () => {
  assert.strictEqual(busiestDay([]), null);
});

test('busiestDay returns null when every day has 0 tokens', () => {
  assert.strictEqual(busiestDay([day('2026-09-10'), day('2026-09-11')]), null);
});

test('busiestDay sums all four token fields for one day', () => {
  const result = busiestDay([day('2026-09-10', { input: 100, output: 20, cacheCreate: 5, cacheRead: 3 })]);
  assert.deepStrictEqual(result, { date: '2026-09-10', tokens: 128 });
});

test('busiestDay picks the day with the most tokens', () => {
  const result = busiestDay([
    day('2026-09-10', { input: 100 }),
    day('2026-09-11', { input: 500 }),
    day('2026-09-12', { input: 200 }),
  ]);
  assert.deepStrictEqual(result, { date: '2026-09-11', tokens: 500 });
});

test('busiestDay keeps the earlier date on a tie', () => {
  const result = busiestDay([
    day('2026-09-12', { input: 300 }),
    day('2026-09-10', { input: 300 }),
    day('2026-09-11', { input: 300 }),
  ]);
  assert.deepStrictEqual(result, { date: '2026-09-10', tokens: 300 });
});

test('busiestDay sums hourly YYYY-MM-DDTHH buckets into their day', () => {
  const result = busiestDay([
    day('2026-09-10T09', { input: 100 }),
    day('2026-09-10T10', { input: 150 }),
    day('2026-09-10T11', { output: 50 }),
  ]);
  assert.deepStrictEqual(result, { date: '2026-09-10', tokens: 300 });
});
