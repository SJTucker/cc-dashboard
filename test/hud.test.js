'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatStatus, shareMeter, dailyWarning, limitStripText } =require('../public/hud');

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

const SESSION = { key: 'five_hour', label: 'Current session', percent: 81 };
const WEEK = { key: 'seven_day', label: 'Current week (all models)', percent: 77 };

test('limitStripText lists every window in high under the Limit label', () => {
  assert.deepStrictEqual(limitStripText([SESSION, WEEK], null), { label: 'Limit', value: 'Session 81% · Week 77%' });
});

test('limitStripText names a single window', () => {
  assert.deepStrictEqual(limitStripText([WEEK], null), { label: 'Limit', value: 'Week 77%' });
});

test('limitStripText shows only the day budget under the Budget label', () => {
  assert.deepStrictEqual(limitStripText([], { share: 18, budget: 20, rolling: false }), { label: 'Budget', value: 'Today 18%' });
});

test('limitStripText appends the day budget after the windows', () => {
  assert.deepStrictEqual(
    limitStripText([{ ...WEEK, percent: 92 }], { share: 30, budget: 31, rolling: true }),
    { label: 'Limit', value: 'Week 92% · Today 30%' }
  );
});

test('limitStripText falls back to the label for an unknown window key', () => {
  assert.deepStrictEqual(limitStripText([{ key: 'opus', label: 'Opus week', percent: 90 }], null), { label: 'Limit', value: 'Opus week 90%' });
});

test('limitStripText returns null when nothing is high', () => {
  assert.strictEqual(limitStripText([], null), null);
});

test('limitStripText rounds the percent', () => {
  assert.deepStrictEqual(limitStripText([{ ...SESSION, percent: 81.6 }], null), { label: 'Limit', value: 'Session 82%' });
});
