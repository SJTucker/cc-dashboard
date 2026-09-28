'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  WEEK_MS, median, percentile, sessionStarts, bashDeltas, bashDaily, promptStats, windowStats, windowRanges, buildReport,
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

test('bashDaily buckets by local date', () => {
  const deltas = [{ t: T0, delta: 100 }, { t: T0 + H, delta: 300 }, { t: T0 + 24 * H, delta: 50 }];
  assert.deepStrictEqual(bashDaily(deltas), [
    { date: '2026-09-10', n: 2, median: 200 },
    { date: '2026-09-11', n: 1, median: 50 },
  ]);
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
    prompts: 0, costPerPrompt: null, callsPerPrompt: null, cacheHit: null,
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
});

test('buildReport attaches before/after windows and rtk entries in range order', () => {
  const markers = [{ t: T0, kind: 'plugin', label: 'x', source: 'plugin' }];
  assert.deepStrictEqual(windowRanges(markers), [[T0 - WEEK_MS, T0], [T0, T0 + WEEK_MS]]);
  const rtk = [{ commands: 1, keptPerCommand: 300, filteredShare: 0.6 }, { commands: 2, keptPerCommand: 100, filteredShare: 0.8 }];
  const report = buildReport({ calls: [call(T0 + 1)], prompts: [] }, markers, rtk, { path: '/x', status: 'missing' });
  assert.strictEqual(report.sessions.length, 1);
  assert.strictEqual(report.markers[0].before.rtk.keptPerCommand, 300);
  assert.strictEqual(report.markers[0].after.rtk.keptPerCommand, 100);
  assert.strictEqual(report.markers[0].after.sessions, 1);
  assert.deepStrictEqual(report.changesFile, { path: '/x', status: 'missing' });
  assert.strictEqual(buildReport({ calls: [], prompts: [] }, markers, null, {}).markers[0].before.rtk, null);
});
