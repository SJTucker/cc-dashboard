'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createScanMemo } = require('../lib/scan-memo');
const { windowStart } = require('../lib/dates');
const { createRowStore } = require('../lib/rowstore');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

// A row store with no rows whose generation the test sets.
function fakeRowStore() {
  const store = { generation: 1, refreshArgs: [], entries: () => [] };
  store.refresh = (...args) => {
    store.refreshArgs.push(args);
    return Promise.resolve();
  };
  return store;
}

// An aggregate that records each call's options and returns a result shaped like
// the real one. `unreadable` sets meta.unreadableFiles.
function countingAggregate(unreadable = () => 0) {
  const fn = (entries, opts) => {
    fn.calls.push(opts);
    return { meta: { unreadableFiles: unreadable() }, daily: [], efficiency: { calls: [] } };
  };
  fn.calls = [];
  return fn;
}

function memoWith({ rowStore = fakeRowStore(), aggregate = countingAggregate() } = {}) {
  const memo = createScanMemo({ getRowStore: () => rowStore, aggregate, getProjectsDir: () => '/p' });
  return { memo, rowStore, aggregate };
}

test('a numeric range is stored without efficiency', async () => {
  const { memo } = memoWith();
  for (const days of [7, 30, 90]) assert.strictEqual((await memo.scan(days)).efficiency, undefined, `days=${days}`);
});

test('the all-time and Today ranges keep efficiency', async () => {
  const { memo } = memoWith();
  assert.ok((await memo.scan(null)).efficiency);
  assert.ok((await memo.scan('today', 'hour')).efficiency);
});

test('aggregate gets the range, the bucket and the projects dir', async () => {
  const { memo, aggregate } = memoWith();
  await memo.scan('today', 'hour');
  assert.deepStrictEqual(aggregate.calls, [{ days: 'today', bucket: 'hour', projectsDir: '/p' }]);
});

test('two concurrent cold calls for the same range aggregate once', async () => {
  const { memo, aggregate } = memoWith();
  const [a, b] = await Promise.all([memo.scan(30), memo.scan(30)]);
  assert.strictEqual(aggregate.calls.length, 1);
  assert.strictEqual(a, b);
});

test('a new row store generation aggregates again', async () => {
  const { memo, rowStore, aggregate } = memoWith();
  await memo.scan(30);
  rowStore.generation = 2;
  await memo.scan(30);
  assert.strictEqual(aggregate.calls.length, 2);
});

test('clear() drops every range', async () => {
  const { memo, aggregate } = memoWith();
  await memo.scan(30);
  await memo.scan(null);
  memo.clear();
  await memo.scan(30);
  await memo.scan(null);
  assert.strictEqual(aggregate.calls.length, 4);
});

test('an unreadable file warns once per change in the count, per range', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let n = 1;
  const { memo, rowStore } = memoWith({ aggregate: countingAggregate(() => n) });
  await memo.scan(30);
  rowStore.generation = 2;
  await memo.scan(30); // same count: no second warning
  n = 2;
  rowStore.generation = 3;
  await memo.scan(30);
  assert.deepStrictEqual(warn.mock.calls.map((c) => c.arguments[0]), [
    '[scan] 1 session file could not be read and was left out of the 30-day totals.',
    '[scan] 2 session files could not be read and were left out of the 30-day totals.',
  ]);
});

test('a numeric or Today range asks the row store to wait for the files modified since the range starts', async () => {
  const { memo, rowStore } = memoWith();
  const now = Date.now();
  await memo.scan('today', 'hour');
  await memo.scan(7);
  await memo.scan(30);

  const since = rowStore.refreshArgs.map(([opts]) => opts.since);
  assert.strictEqual(rowStore.refreshArgs.length, 3);
  assert.deepStrictEqual(since, [windowStart('today', now), windowStart(7, now), windowStart(30, now)]);
});

test('the all-time range waits for the whole run: refresh gets no since', async () => {
  const { memo, rowStore } = memoWith();
  await memo.scan(null);
  assert.deepStrictEqual(rowStore.refreshArgs, [[]]);
});

// Three transcripts, aged 0, 2 days and 20 days, read through a real row store whose
// extract is gatedExtract() (test/helpers.js). prepare() reads them once, then modifies
// each so that all three are out of date, and from then on a read waits for
// release(file). The store's pool stand-in asks for the three files at once, so they
// can finish in any order. touch(file) modifies a file again.
function heldStore(t) {
  const dir = helpers.tmpDir(t, 'scan-memo');
  const DAY = 24 * 3600 * 1000;
  const make = (name, ageMs) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, '\n');
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, seconds, seconds);
    return file;
  };
  const files = { fresh: make('fresh', 0), mid: make('mid', 2 * DAY), old: make('old', 20 * DAY) };
  const g = helpers.gatedExtract();
  const clock = { now: Date.now() };
  const rowStore = createRowStore({
    projectsDir: () => dir,
    now: () => clock.now,
    openPool: (size, fn) => fn({ extract: g.extract }),
    poolLimits: { files: 0, bytes: 0 },
  });
  const touch = (file) => {
    const seconds = fs.statSync(file).mtimeMs / 1000 + 1;
    fs.utimesSync(file, seconds, seconds);
  };
  async function prepare() {
    await rowStore.refresh();
    for (const file of Object.values(files)) touch(file);
    clock.now += 2001;
    g.ctl.hold = true;
  }
  return { rowStore, files, prepare, touch, clock, ctl: g.ctl, release: g.release };
}

test('a 7-day aggregate built while the 20-day-old file is still being read is built again after it loads, and all-time waits for it', { timeout: 5000 }, async (t) => {
  const { rowStore, files, prepare, release } = heldStore(t);
  await prepare();
  const aggregate = countingAggregate();
  const memo = createScanMemo({ getRowStore: () => rowStore, aggregate, getProjectsDir: () => '/p' });
  let allTimeDone = false;

  const week = memo.scan(7);
  const allTime = memo.scan(null).then(() => { allTimeDone = true; });
  release(files.fresh);
  release(files.mid);
  await week;
  assert.strictEqual(aggregate.calls.length, 1, 'the 7-day range was aggregated without the 20-day-old file');
  assert.strictEqual(allTimeDone, false);

  release(files.old);
  await allTime;
  assert.strictEqual(aggregate.calls.length, 2, 'the all-time range was aggregated once the run finished');
  await memo.scan(7);
  assert.strictEqual(aggregate.calls.length, 3, 'the earlier 7-day aggregate is not reused');
});

test('a Today aggregate built while older files are being read is built again after it, and again after a later change to a file in range', { timeout: 5000 }, async (t) => {
  const { rowStore, files, prepare, touch, clock, ctl, release } = heldStore(t);
  await prepare();
  const aggregate = countingAggregate();
  const memo = createScanMemo({ getRowStore: () => rowStore, aggregate, getProjectsDir: () => '/p' });

  const today = memo.scan('today', 'hour');
  release(files.fresh);
  await today;
  assert.strictEqual(aggregate.calls.length, 1, 'built while the 2-day-old and 20-day-old files were still being read');

  release(files.mid);
  release(files.old);
  await rowStore.refresh();
  await memo.scan('today', 'hour');
  assert.strictEqual(aggregate.calls.length, 2, 'the run changed older entries, so the earlier aggregate is not reused');

  touch(files.fresh);
  clock.now += 2001;
  ctl.hold = false;
  await memo.scan('today', 'hour');
  assert.strictEqual(aggregate.calls.length, 3, 'a file in range changed after the run');
});
