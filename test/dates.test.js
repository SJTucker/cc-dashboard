'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { windowStart, localDateStr, localHourStr } = require('../lib/dates');

const ROOT = path.join(__dirname, '..');
const NOW = new Date(2026, 8, 30, 15, 42, 7).getTime();

// Runs `body` in a child process whose zone is New York, which has daylight saving
// changes, and returns the JSON value the body returns. The zone is passed in the
// child's environment, so this process's environment is left alone.
function inNewYork(body) {
  const script = `process.stdout.write(JSON.stringify((() => { ${body} })()));`;
  const out = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York' },
  });
  assert.strictEqual(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test("windowStart('today') is local midnight", () => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  assert.strictEqual(windowStart('today', NOW), d.getTime());
});

test('windowStart(7) is midnight 6 days before today', () => {
  assert.strictEqual(windowStart(7, NOW), new Date(2026, 8, 24).getTime());
});

test("windowStart(1) equals windowStart('today')", () => {
  assert.strictEqual(windowStart(1, NOW), windowStart('today', NOW));
});

test('windowStart(null) is null', () => {
  assert.strictEqual(windowStart(null, NOW), null);
});

test('windowStart throws for a days value that is not a range', () => {
  for (const bad of [0, -3, 1.5, NaN, '7', 'abc']) {
    assert.throws(() => windowStart(bad, NOW), TypeError, String(bad));
  }
});

test('localDateStr and localHourStr pad every field', () => {
  const d = new Date(2026, 0, 5, 7, 3);
  assert.strictEqual(localDateStr(d), '2026-01-05');
  assert.strictEqual(localHourStr(d), '2026-01-05T07');
});

test('windowStart(30) across a DST change still starts at midnight', () => {
  const start = inNewYork(`
    const { windowStart } = require('./lib/dates');
    const d = new Date(windowStart(30, new Date(2026, 10, 3, 12).getTime()));
    return [d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
  `);
  assert.deepStrictEqual(start, [9, 5, 0, 0]);
});

test('hourSlots gives 23 keys on the spring-forward day, with no 02', () => {
  const keys = inNewYork(`
    const { hourSlots, windowStart } = require('./lib/dates');
    return hourSlots(windowStart('today', new Date(2026, 2, 8, 12).getTime()));
  `);
  assert.strictEqual(keys.length, 23);
  assert.ok(!keys.includes('2026-03-08T02'));
  assert.strictEqual(keys[0], '2026-03-08T00');
  assert.strictEqual(keys[22], '2026-03-08T23');
});

test('hourSlots gives 24 keys on the fall-back day, with the repeated 01 once', () => {
  const keys = inNewYork(`
    const { hourSlots, windowStart } = require('./lib/dates');
    return hourSlots(windowStart('today', new Date(2026, 10, 1, 12).getTime()));
  `);
  assert.strictEqual(keys.length, 24);
  assert.strictEqual(keys.filter((k) => k === '2026-11-01T01').length, 1);
  assert.deepStrictEqual(keys, [...keys].sort(), 'keys are in order');
});

test('fillHourAxis and aggregate give the same hour keys on both change days', () => {
  for (const [m, d] of [[2, 8], [10, 1]]) {
    const { rtk, agg } = inNewYork(`
      const { fillHourAxis } = require('./lib/rtk');
      const { aggregate } = require('./lib/aggregate');
      const now = new Date(2026, ${m}, ${d}, 12).getTime();
      const daily = [];
      fillHourAxis(daily, now);
      return { rtk: daily.map((x) => x.date), agg: aggregate([], { days: 'today', bucket: 'hour', now }).daily.map((x) => x.date) };
    `);
    assert.deepStrictEqual(rtk, agg, `2026-${m + 1}-${d}`);
  }
});
