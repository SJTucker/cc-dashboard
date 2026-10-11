'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers');
const { withPool, poolSize, failedRows } = require('../lib/extract-pool');
const { extractFile } = require('../lib/extract');

const FIXTURES = path.join(__dirname, 'fixtures');
const worker = (name) => ({ workerFile: path.join(FIXTURES, name) });

// A transcript with one call, and a title line for a session whose id would be a
// prototype key if `sessions` had a prototype.
function writeTranscript(dir, name, sessionId = '__proto__') {
  const file = path.join(dir, `${name}.jsonl`);
  const lines = [
    { type: 'ai-title', sessionId, aiTitle: 'Pool test' },
    { timestamp: '2026-10-08T12:00:00.000Z', sessionId, requestId: `req-${name}`, message: { id: `msg-${name}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('poolSize is one fewer than the cores, at most 8 and at least 1', () => {
  assert.strictEqual(poolSize(), Math.max(1, Math.min(os.availableParallelism() - 1, 8)));
  assert.ok(poolSize() >= 1 && poolSize() <= 8);
});

test('a file extracted in a worker gives the rows extractFile gives, with a null-prototype sessions', async (t) => {
  const dir = helpers.tmpDir(t, 'pool');
  const file = writeTranscript(dir, 'a');
  await withPool(2, async (pool) => {
    const rows = await pool.extract(file);
    assert.strictEqual(Object.getPrototypeOf(rows.sessions), null);
    assert.deepStrictEqual(Object.keys(rows.sessions), ['__proto__']);
    assert.strictEqual(rows.sessions['__proto__'].title, 'Pool test');
    assert.deepStrictEqual(rows, await extractFile(file));
  });
});

test('more files than workers are all extracted', async (t) => {
  const dir = helpers.tmpDir(t, 'pool');
  const files = Array.from({ length: 7 }, (_, i) => writeTranscript(dir, `f${i}`));
  await withPool(2, async (pool) => {
    const all = await Promise.all(files.map((f) => pool.extract(f)));
    assert.deepStrictEqual(all.map((r) => r.calls.length), files.map(() => 1));
    assert.ok(all.every((r) => r.ok));
  });
});

test('a worker that exits mid-task resolves its file as failed rows, and the files queued behind it too', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await withPool(1, async (pool) => {
    const [a, b, c] = await Promise.all([pool.extract('/x/a.jsonl'), pool.extract('/x/b.jsonl'), pool.extract('/x/c.jsonl')]);
    for (const rows of [a, b, c]) assert.deepStrictEqual(rows, failedRows());
    assert.strictEqual(pool.live, 0);
    assert.strictEqual(await pool.started, false, 'no worker ever answered');
    assert.deepStrictEqual(await pool.extract('/x/d.jsonl'), failedRows(), 'a file asked for after the last worker stopped does not wait');
  }, worker('exit-worker.js'));
  assert.strictEqual(warn.mock.calls.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /A worker stopped \(exit code 3\)\. Its file \/x\/a\.jsonl counts as unreadable/);
});

test('a pool whose workers all die after one answer has started, so its failed files stay failed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = helpers.tmpDir(t, 'pool');
  const files = ['a', 'b', 'c'].map((name) => writeTranscript(dir, name));
  await withPool(1, async (pool) => {
    const [first, second, third] = await Promise.all(files.map((f) => pool.extract(f)));
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(second, failedRows());
    assert.deepStrictEqual(third, failedRows());
    assert.strictEqual(pool.live, 0);
    assert.strictEqual(await pool.started, true);
  }, worker('die-after-first-worker.js'));
});

test('a pool with a working worker reports that it started', async (t) => {
  const dir = helpers.tmpDir(t, 'pool');
  await withPool(1, async (pool) => {
    await pool.extract(writeTranscript(dir, 'a'));
    assert.strictEqual(await pool.started, true);
  });
});

test('a worker that cannot be created counts as stopped, and a pool that creates none has not started', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await withPool(2, async (pool) => {
    assert.strictEqual(pool.live, 0);
    assert.strictEqual(await pool.started, false);
    assert.deepStrictEqual(await pool.extract('/x/a.jsonl'), failedRows());
  }, { createWorker: () => { throw new Error('no threads'); } });
  assert.strictEqual(warn.mock.calls.length, 2);
  assert.match(warn.mock.calls[0].arguments[0], /A worker stopped \(no threads\)/);
});

test('a worker that emits an error resolves its file as failed rows', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await withPool(1, async (pool) => {
    assert.deepStrictEqual(await pool.extract('/x/a.jsonl'), failedRows());
  }, worker('crash-worker.js'));
  assert.match(warn.mock.calls[0].arguments[0], /worker crashed/);
});

test('one dead worker leaves the others to finish the queue', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = helpers.tmpDir(t, 'pool');
  const die = writeTranscript(dir, 'die1');
  const ok = ['ok1', 'ok2', 'ok3'].map((name) => writeTranscript(dir, name));
  await withPool(2, async (pool) => {
    const [dead, ...alive] = await Promise.all([die, ...ok].map((f) => pool.extract(f)));
    assert.deepStrictEqual(dead, failedRows());
    assert.deepStrictEqual(alive.map((r) => [r.ok, r.calls.length]), [[true, 1], [true, 1], [true, 1]]);
    assert.strictEqual(pool.live, 1);
  }, worker('die-on-one-worker.js'));
});

test('a throw inside extractFile rejects, as a throw on the main thread would', async () => {
  await withPool(1, async (pool) => {
    await assert.rejects(pool.extract('/x/a.jsonl'), /boom \/x\/a\.jsonl/);
  }, worker('error-worker.js'));
});

test('withPool closes the pool when its function throws', async () => {
  let seen;
  await assert.rejects(
    withPool(2, async (pool) => {
      seen = pool;
      assert.strictEqual(pool.live, 2);
      throw new Error('read pass failed');
    }),
    /read pass failed/,
  );
  assert.strictEqual(seen.closed, true);
  assert.strictEqual(seen.live, 0);
});
