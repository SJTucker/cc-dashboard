'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatStatus, shareMeter } = require('../public/hud');

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
