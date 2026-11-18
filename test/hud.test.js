'use strict';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert');
let formatStatus, shareMeter, dailyWarning, limitStripText, limitsBannerParts, planWindows, creditsText, paceBar, paceDetail;
before(async () => { ({ formatStatus, shareMeter, dailyWarning, limitStripText, limitsBannerParts, planWindows, creditsText, paceBar, paceDetail } = await import('../public/hud.mjs')); });

test('formatStatus shows the load time as 24-hour local HH:MM:SS and counts with separators', () => {
  const loadedAt = new Date(2026, 8, 30, 10, 24, 21).getTime();
  assert.deepStrictEqual(formatStatus({ loadedAt, sessions: 97, apiCalls: 43693 }), {
    sync: '10:24:21',
    sessions: '97',
    apiCalls: '43,693',
  });
});

test('formatStatus pads a time just after midnight', () => {
  const loadedAt = new Date(2026, 8, 30, 0, 5, 9).getTime();
  assert.strictEqual(formatStatus({ loadedAt, sessions: 0, apiCalls: 0 }).sync, '00:05:09');
});

test('formatStatus shows a dash for anything not known yet', () => {
  assert.deepStrictEqual(formatStatus({ loadedAt: null, sessions: undefined, apiCalls: undefined }), {
    sync: '—',
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

test('limitsBannerParts ties each window to its reset and the day budget to the date', () => {
  const high = [{ key: 'five_hour', resetsAt: 1000 }, { key: 'seven_day', resetsAt: 2000 }];
  assert.deepStrictEqual(limitsBannerParts(high, { share: 14, budget: 14, rolling: true }, '2026-10-14'), [
    'five_hour@1000', 'seven_day@2000', 'today@2026-10-14',
  ]);
});

test('limitsBannerParts changes when a window resets or a new day starts', () => {
  const before = limitsBannerParts([{ key: 'seven_day', resetsAt: 2000 }], {}, '2026-10-14');
  assert.notDeepStrictEqual(limitsBannerParts([{ key: 'seven_day', resetsAt: 3000 }], {}, '2026-10-14'), before);
  assert.notDeepStrictEqual(limitsBannerParts([{ key: 'seven_day', resetsAt: 2000 }], {}, '2026-10-15'), before);
});

test('limitsBannerParts is empty when nothing warns', () => {
  assert.deepStrictEqual(limitsBannerParts([], null, '2026-10-14'), []);
});

const FABLE = { key: 'weekly_scoped:Fable', label: 'Current week (Fable)', percent: 90 };
const CREDITS_ROW = {
  key: 'credits', label: 'Usage credits', percent: 95,
  credits: { usedMinor: 19000, limitMinor: 20000, currency: 'USD', decimalPlaces: 2 },
};

test('planWindows keeps only the session and weekly windows, in order', () => {
  assert.deepStrictEqual(planWindows([SESSION, FABLE, WEEK, CREDITS_ROW]), [SESSION, WEEK]);
  assert.deepStrictEqual(planWindows([FABLE, CREDITS_ROW]), []);
});

test('a scoped week or credits row at 90% adds no banner part and no strip text', () => {
  const high = planWindows([FABLE, CREDITS_ROW]);
  assert.deepStrictEqual(limitsBannerParts(high, null, '2026-10-14'), []);
  assert.strictEqual(limitStripText(high, null), null);
});

test('creditsText shows the spend and the cap in the account currency', () => {
  assert.strictEqual(creditsText({ usedMinor: 4117, limitMinor: 20000, currency: 'USD', decimalPlaces: 2 }), '$41.17 of $200.00 spent');
  assert.strictEqual(creditsText({ usedMinor: 4117, limitMinor: 20000, currency: 'JPY', decimalPlaces: 0 }), '¥4,117 of ¥20,000 spent');
});

const fastPace = { state: 'fast', ratePerHour: 120, fastPerHour: 24, runsOutAt: 1000, resetsAt: 5000, busy: null };
const stubClock = () => '10:57';
const stubReset = () => 'resets 11am';

test('paceBar caps fill at 100 and hides a marker at 100 or more', () => {
  assert.deepStrictEqual(paceBar({ ...fastPace, ratePerHour: 250, fastPerHour: 24 }), { fill: 100, marker: 24, striped: true });
  assert.strictEqual(paceBar({ ...fastPace, fastPerHour: 100 }).marker, null);
  assert.strictEqual(paceBar({ ...fastPace, fastPerHour: 400 }).marker, null);
});

test('paceBar is striped only when fast', () => {
  assert.strictEqual(paceBar({ ...fastPace, state: 'steady', ratePerHour: 30 }).striped, false);
  assert.strictEqual(paceBar({ ...fastPace, state: 'idle', ratePerHour: 0 }).striped, false);
  assert.strictEqual(paceBar(fastPace).striped, true);
});

test('paceBar stripes the whole fill when fast with no marker', () => {
  assert.deepStrictEqual(paceBar({ ...fastPace, ratePerHour: 80, fastPerHour: 150 }), { fill: 80, marker: null, striped: true });
});

test('paceDetail words the run-out time, the reset and the idle case', () => {
  assert.strictEqual(paceDetail(fastPace, stubClock, stubReset), 'lasts until about 10:57 · resets 11am');
  assert.strictEqual(paceDetail({ ...fastPace, state: 'steady', runsOutAt: 9000 }, stubClock, stubReset), 'lasts past the reset · resets 11am');
  assert.strictEqual(paceDetail({ ...fastPace, state: 'idle', runsOutAt: null }, stubClock, stubReset), 'resets 11am');
});

test('limitStripText shows pace first when fast', () => {
  assert.deepStrictEqual(limitStripText([], null, fastPace, stubClock), { label: '5h pace', value: 'runs out 10:57' });
  assert.deepStrictEqual(
    limitStripText([{ key: 'five_hour', label: 'Current session', percent: 75 }], null, fastPace, stubClock),
    { label: '5h pace', value: 'runs out 10:57 · Session 75%' },
  );
  assert.strictEqual(limitStripText([], null, { ...fastPace, state: 'steady' }, stubClock), null);
});

test('limitsBannerParts adds pace@<resetsAt> when fast', () => {
  assert.deepStrictEqual(limitsBannerParts([], null, '2026-11-18', fastPace), ['pace@5000']);
  assert.deepStrictEqual(limitsBannerParts([], null, '2026-11-18', { ...fastPace, state: 'steady' }), []);
});
