'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatStatus, shareMeter, dailyWarning } = require('../public/hud');

test('formatStatus shows the load time as 24-hour local HH:MM:SS and counts with separators', () => {
  const loadedAt = new Date(2026, 8, 30, 10, 24, 21).getTime();
  assert.deepStrictEqual(formatStatus({ loadedAt, range: 'Today', sessions: 97, apiCalls: 43693 }), {
    sync: '10:24:21',
    range: 'Today',
    sessions: '97',
    apiCalls: '43,693',
  });
});

test('formatStatus pads a time just after midnight', () => {
  const loadedAt = new Date(2026, 8, 30, 0, 5, 9).getTime();
  assert.strictEqual(formatStatus({ loadedAt, range: '7d', sessions: 0, apiCalls: 0 }).sync, '00:05:09');
});

test('formatStatus shows a dash for anything not known yet', () => {
  assert.deepStrictEqual(formatStatus({ loadedAt: null, range: '', sessions: undefined, apiCalls: undefined }), {
    sync: '—',
    range: '—',
    sessions: '—',
    apiCalls: '—',
  });
});

test('shareMeter fills against 100% and ticks at the budget on a workday', () => {
  assert.deepStrictEqual(shareMeter({ share: 3, budget: 20 }), { fill: 3, tick: 20 });
});

test('shareMeter has no tick at the weekend and still fills', () => {
  assert.deepStrictEqual(shareMeter({ share: 7, budget: null }), { fill: 7, tick: null });
});

test('shareMeter clamps the fill to 0 to 100', () => {
  assert.strictEqual(shareMeter({ share: 130, budget: 20 }).fill, 100);
  assert.strictEqual(shareMeter({ share: -2, budget: 20 }).fill, 0);
});

test('dailyWarning fires within 1 point of the rolling budget', () => {
  assert.deepStrictEqual(dailyWarning({ share: 31, budget: 20, rollingBudget: 32 }), { share: 31, budget: 32, rolling: true });
  assert.strictEqual(dailyWarning({ share: 30, budget: 20, rollingBudget: 32 }), null);
});

test('dailyWarning ignores the fixed budget when the rolling budget is higher', () => {
  assert.strictEqual(dailyWarning({ share: 25, budget: 20, rollingBudget: 32 }), null);
});

test('dailyWarning rounds both values the way the panel shows them', () => {
  assert.deepStrictEqual(dailyWarning({ share: 30.6, budget: 20, rollingBudget: 31.6 }), { share: 31, budget: 32, rolling: true });
});

test('dailyWarning falls back to the fixed budget when the rolling budget is unknown', () => {
  assert.deepStrictEqual(dailyWarning({ share: 19, budget: 20, rollingBudget: null }), { share: 19, budget: 20, rolling: false });
});

test('dailyWarning never fires at the weekend or without a reading', () => {
  assert.strictEqual(dailyWarning({ share: 50, budget: null, rollingBudget: null }), null);
  assert.strictEqual(dailyWarning(null), null);
});
