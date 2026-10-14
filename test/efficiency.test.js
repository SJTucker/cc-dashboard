'use strict';

// Day and hour buckets use local time, so the zone is set before any Date is made.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert');
const {
  WEEK_MS, median, percentile, sessionStarts, bashDeltas, promptStats, stats, windowStats, dailySeries, windowRanges, buildReport,
} = require('../lib/efficiency');

const H = 60 * 60 * 1000;
const T0 = new Date('2026-09-10T12:00:00').getTime(); // local noon

function call(t, over = {}) {
  return { t, sessionId: 's1', main: true, model: 'claude-opus-5', context: 1000, cacheRead: 900, output: 50, cost: 0.1, tools: [], ...over };
}

test('median and percentile handle empty, odd and even inputs', () => {
  assert.strictEqual(median([]), null);
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(percentile([], 90), null);
  assert.strictEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('sessionStarts takes the earliest main-thread call per session', () => {
  const calls = [
    call(T0 + H, { context: 2000 }),
    call(T0, { main: false, context: 99 }),
    call(T0 + 30 * 60 * 1000, { context: 1500 }),
    call(T0, { sessionId: 's2', context: 700, model: 'claude-opus-5-5' }),
  ];
  assert.deepStrictEqual(sessionStarts(calls), [
    { t: T0, model: 'claude-opus-5-5', context: 700 },
    { t: T0 + 30 * 60 * 1000, model: 'claude-opus-5', context: 1500 },
  ]);
});

test('sessionStarts ignores sessions with no main-thread call', () => {
  assert.deepStrictEqual(sessionStarts([call(T0, { main: false })]), []);
  assert.deepStrictEqual(bashDeltas([call(T0, { main: false, tools: ['Bash'] }), call(T0 + 1, { main: false })]), []);
});

test('bashDeltas: context growth after an all-Bash response, negatives dropped', () => {
  const calls = [
    call(T0, { context: 1000, output: 50, tools: ['Bash'] }),
    call(T0 + 1000, { context: 1400, output: 20, tools: ['Bash', 'Read'] }), // 1400-1000-50 = 350
    call(T0 + 2000, { context: 9000, output: 10, tools: ['Bash'] }), // after a mixed response: skipped
    call(T0 + 3000, { context: 500 }), // compaction: 500-9000-10 < 0, dropped
    call(T0 + 4000, { main: false, context: 1, tools: ['Bash'] }), // subagent: other thread
  ];
  assert.deepStrictEqual(bashDeltas(calls), [{ t: T0 + 1000, delta: 350 }]);
});

test('promptStats sums main and subagent calls up to the next prompt, dropping empty prompts', () => {
  const prompts = [{ t: T0, sessionId: 's1' }, { t: T0 + H, sessionId: 's1' }, { t: T0 + 2 * H, sessionId: 's1' }];
  const calls = [
    call(T0 + 1, { cost: 0.5 }),
    call(T0 + 2, { main: false, cost: 0.25 }),
    call(T0 + H + 1, { cost: 1 }),
    call(T0 + 5, { sessionId: 's2', cost: 9 }), // another session
  ];
  assert.deepStrictEqual(promptStats(prompts, calls), [
    { t: T0, cost: 0.75, calls: 2 },
    { t: T0 + H, cost: 1, calls: 1 },
  ]);
});

test('windowStats on an empty window returns nulls', () => {
  const w = windowStats({ starts: [], deltas: [], prompts: [], calls: [] }, T0, T0 + WEEK_MS);
  assert.deepStrictEqual(w, {
    sessions: 0, sessionStart: null, bashN: 0, bashMedian: null, bashP90: null,
    prompts: 0, costPerPrompt: null, callsPerPrompt: null, callN: 0, cacheHit: null, thinkingN: 0, thinkingShare: null,
  });
});

test('windowStats includes from and excludes to', () => {
  const data = {
    starts: [{ t: T0, context: 10 }, { t: T0 + WEEK_MS, context: 99 }],
    deltas: [{ t: T0, delta: 5 }],
    prompts: [{ t: T0, cost: 2, calls: 3 }],
    calls: [call(T0, { context: 1000, cacheRead: 750 }), call(T0 + WEEK_MS, { context: 1000, cacheRead: 0 })],
  };
  const w = windowStats(data, T0, T0 + WEEK_MS);
  assert.strictEqual(w.sessions, 1);
  assert.strictEqual(w.sessionStart, 10);
  assert.strictEqual(w.bashMedian, 5);
  assert.strictEqual(w.costPerPrompt, 2);
  assert.strictEqual(w.callsPerPrompt, 3);
  assert.strictEqual(w.cacheHit, 0.75);
  assert.strictEqual(w.callN, 1);
});

// Sep 10 has a session, two Bash results and one call. Sep 11 has one Bash result,
// one prompt and one call. Sep 10 has no prompt, so it is absent from the two
// per-prompt series instead of appearing with a null value.
const TWO_DAYS = {
  starts: [{ t: T0, context: 40000 }],
  deltas: [{ t: T0, delta: 100 }, { t: T0 + H, delta: 300 }, { t: T0 + 24 * H, delta: 50 }],
  prompts: [{ t: T0 + 24 * H, cost: 0.5, calls: 4 }],
  calls: [call(T0, { context: 1000, cacheRead: 900 }), call(T0 + 24 * H, { context: 2000, cacheRead: 1000 })],
};

test('dailySeries gives each row its value and count per local day', () => {
  assert.deepStrictEqual(dailySeries(TWO_DAYS), {
    sessionStart: [{ date: '2026-09-10', n: 1, value: 40000 }],
    bashMedian: [{ date: '2026-09-10', n: 2, value: 200 }, { date: '2026-09-11', n: 1, value: 50 }],
    bashP90: [{ date: '2026-09-10', n: 2, value: 300 }, { date: '2026-09-11', n: 1, value: 50 }],
    costPerPrompt: [{ date: '2026-09-11', n: 1, value: 0.5 }],
    callsPerPrompt: [{ date: '2026-09-11', n: 1, value: 4 }],
    cacheHit: [{ date: '2026-09-10', n: 1, value: 0.9 }, { date: '2026-09-11', n: 1, value: 0.5 }],
    thinkingShare: [],
  });
});

test('dailySeries on no records gives every row an empty series', () => {
  const empty = dailySeries({ starts: [], deltas: [], prompts: [], calls: [] });
  assert.deepStrictEqual(Object.keys(empty).sort(), ['bashMedian', 'bashP90', 'cacheHit', 'callsPerPrompt', 'costPerPrompt', 'sessionStart', 'thinkingShare']);
  for (const series of Object.values(empty)) assert.deepStrictEqual(series, []);
});

test('a day of dailySeries matches windowStats over that day', () => {
  const from = new Date('2026-09-10T00:00:00').getTime();
  const to = new Date('2026-09-11T00:00:00').getTime();
  const w = windowStats(TWO_DAYS, from, to);
  for (const [key, series] of Object.entries(dailySeries(TWO_DAYS))) {
    const day = series.find((d) => d.date === '2026-09-10');
    assert.strictEqual(day ? day.value : null, w[key], key);
  }
});

test('stats takes lists that are already cut to a span', () => {
  assert.deepStrictEqual(stats(TWO_DAYS), windowStats(TWO_DAYS, 0, Infinity));
});

test('buildReport attaches before/after windows and rtk entries in range order', () => {
  const markers = [{ t: T0, kind: 'plugin', label: 'x', source: 'plugin' }];
  assert.deepStrictEqual(windowRanges(markers), [[T0 - WEEK_MS, T0], [T0, T0 + WEEK_MS]]);
  const rtk = [{ commands: 1, reachedPerCommand: 300, keptOutShare: 0.6 }, { commands: 2, reachedPerCommand: 100, keptOutShare: 0.8 }];
  const report = buildReport({ calls: [call(T0 + 1)], prompts: [] }, markers, rtk, { path: '/x', status: 'missing' });
  assert.strictEqual(report.sessions.length, 1);
  assert.deepStrictEqual(report.daily.sessionStart, [{ date: '2026-09-10', n: 1, value: 1000 }]);
  assert.strictEqual(report.markers[0].before.rtk.reachedPerCommand, 300);
  assert.strictEqual(report.markers[0].after.rtk.reachedPerCommand, 100);
  assert.strictEqual(report.markers[0].after.sessions, 1);
  assert.deepStrictEqual(report.changesFile, { path: '/x', status: 'missing' });
  assert.strictEqual(buildReport({ calls: [], prompts: [] }, markers, null, {}).markers[0].before.rtk, null);
});

test('the browser and the server share one median and percentile', async () => {
  const stats = await import('../public/stats.mjs');
  assert.strictEqual(median, stats.median);
  assert.strictEqual(percentile, stats.percentile);
});

// windowStats as it was before the binary search: a filter of every list.
function filteredWindowStats({ starts, deltas, prompts, calls }, from, to) {
  const inWindow = (x) => x.t >= from && x.t < to;
  return stats({
    starts: starts.filter(inWindow),
    deltas: deltas.filter(inWindow),
    prompts: prompts.filter(inWindow),
    calls: calls.filter(inWindow),
  });
}

// Four lists sorted by t, with times on both sides of T0 and T0 + WEEK_MS, repeated
// times at each boundary, and one time well outside.
function boundaryData() {
  const times = [T0 - WEEK_MS, T0 - 1, T0, T0, T0 + 1, T0 + H, T0 + WEEK_MS - 1, T0 + WEEK_MS, T0 + WEEK_MS, T0 + WEEK_MS + 1, T0 + 3 * WEEK_MS];
  return {
    starts: times.map((t, i) => ({ t, context: 100 + i, model: 'claude-opus-5' })),
    deltas: times.map((t, i) => ({ t, delta: 10 * (i + 1) })),
    prompts: times.map((t, i) => ({ t, cost: 0.5 + i, calls: i + 1 })),
    calls: times.map((t, i) => call(t, { context: 1000 + i, cacheRead: 500 + i })),
  };
}

test('windowStats gives the same stats as filtering every list, at the boundaries and with repeated times', () => {
  const data = boundaryData();
  const spans = [
    [T0, T0 + WEEK_MS], [T0 - WEEK_MS, T0], [T0 + WEEK_MS, T0 + 2 * WEEK_MS], [T0 + 2 * WEEK_MS, T0 + 3 * WEEK_MS],
    [T0, T0], [T0 + WEEK_MS, T0], [T0 + 1, T0 + 1], [0, Infinity], [-Infinity, T0], [NaN, T0],
  ];
  for (const [from, to] of spans) {
    assert.deepStrictEqual(windowStats(data, from, to), filteredWindowStats(data, from, to), `[${from}, ${to})`);
  }
});

test('windowStats reads a few elements of a long list, not every one', () => {
  const calls = Array.from({ length: 10000 }, (_, i) => call(T0 + i * 1000));
  let reads = 0;
  const watched = new Proxy(calls, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const w = windowStats({ starts: [], deltas: [], prompts: [], calls: watched }, T0 + 5000 * 1000, T0 + 5010 * 1000);
  assert.strictEqual(w.callN, 10);
  assert.ok(reads < 100, `read ${reads} elements`);
});

test('buildReport leaves the order of the calls it was given unchanged and counts them by time', () => {
  const calls = [call(T0 + 3000), call(T0 + 1000), call(T0 + 2000), call(T0 - 1000)];
  const before = calls.map((c) => c.t);
  const markers = [{ t: T0, kind: 'plugin', label: 'x', source: 'plugin' }];
  const report = buildReport({ calls, prompts: [] }, markers, null, {});
  assert.deepStrictEqual(calls.map((c) => c.t), before);
  assert.strictEqual(report.markers[0].before.callN, 1);
  assert.strictEqual(report.markers[0].after.callN, 3);
});

test('stats: thinking share is over the calls that report thinking only', () => {
  const s = stats({
    starts: [], deltas: [], prompts: [],
    calls: [
      call(T0, { output: 100, thinking: 40 }),
      call(T0 + 1, { output: 60, thinking: 0 }),
      call(T0 + 2, { output: 500, thinking: null }),
      call(T0 + 3, { output: 900 }),
    ],
  });
  assert.strictEqual(s.thinkingN, 2);
  assert.strictEqual(s.thinkingShare, 0.25);
});

test('stats: no thinking share when the calls that report it have no output', () => {
  const s = stats({ starts: [], deltas: [], prompts: [], calls: [call(T0, { output: 0, thinking: 0 })] });
  assert.strictEqual(s.thinkingN, 1);
  assert.strictEqual(s.thinkingShare, null);
});

test('dailySeries gives the thinking share per day with its call count', () => {
  const series = dailySeries({
    starts: [], deltas: [], prompts: [],
    calls: [call(T0, { output: 100, thinking: 40 }), call(T0 + 1, { output: 60, thinking: 0 }), call(T0 + 24 * H, { output: 10 })],
  });
  assert.deepStrictEqual(series.thinkingShare, [{ date: '2026-09-10', n: 2, value: 0.25 }]);
});
