'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createScanMemo } = require('../lib/scan-memo');

// A row store with no rows whose generation the test sets.
function fakeRowStore() {
  return { generation: 1, refresh: () => Promise.resolve(), entries: () => [] };
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
