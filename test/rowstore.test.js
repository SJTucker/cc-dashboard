'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createRowStore, REFRESH_SHARE_MS } = require('../lib/rowstore');
const { extractFile, EXTRACT_VERSION } = require('../lib/extract');
const { openStore } = require('../lib/store');
const { aggregate } = require('../lib/aggregate');

const DAY_MS = 24 * 60 * 60 * 1000;

function makeProjects() {
  const base = helpers.tmpDir(null, 'rowstore');
  const dir = path.join(base, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  return { base, dir };
}

const usageLine = (id, ts) => JSON.stringify({
  timestamp: ts,
  requestId: `req-${id}`,
  message: { id: `msg-${id}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
});

// Writes a transcript. `ageMs` sets its mtime that far in the past.
function writeFile(dir, name, ids, ageMs = 0) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, ids.map((id) => usageLine(id, new Date(Date.now() - ageMs).toISOString())).join('\n') + '\n');
  const seconds = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}

// A real extract that records which files it read. `clock` is the store's `now`, which
// the tests advance past REFRESH_SHARE_MS instead of sleeping.
function harness(dir, { store = null } = {}) {
  const reads = [];
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    store,
    now: () => clock.now,
    extract: (file) => {
      reads.push(file);
      return extractFile(file);
    },
  });
  const refresh = async () => {
    clock.now += REFRESH_SHARE_MS + 1;
    await rows.refresh();
  };
  return { rows, reads, refresh, clock };
}

const tmpDb = () => path.join(helpers.tmpDir(null, 'rowstore-db'), 'transcripts.db');

test('an unchanged file is read once, however many refreshes run', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1']);
  const { rows, reads, refresh } = harness(dir);

  await refresh();
  await refresh();
  await refresh();

  assert.deepStrictEqual(reads, [file]);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
});

test('a size change re-reads the file, and so does an mtime change with the same size', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1']);
  const { rows, reads, refresh } = harness(dir);
  await refresh();

  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await refresh();
  assert.strictEqual(reads.length, 2);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 2);

  const later = Date.now() / 1000 + 100;
  fs.utimesSync(file, later, later);
  await refresh();
  assert.strictEqual(reads.length, 3);
});

test('generation moves only when an entry changes', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1']);
  const { rows, refresh } = harness(dir);

  await refresh();
  const first = rows.generation;
  await refresh();
  assert.strictEqual(rows.generation, first);

  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await refresh();
  assert.ok(rows.generation > first);
});

test('refresh calls that overlap share one run, and one that follows within 2 s reuses it', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'a', ['1']);
  const reads = [];
  const clock = { now: 1_000_000 };
  const rows = createRowStore({
    projectsDir: () => dir,
    now: () => clock.now,
    extract: (file) => {
      reads.push(file);
      return extractFile(file);
    },
  });

  await Promise.all([rows.refresh(), rows.refresh()]);
  assert.strictEqual(reads.length, 1);

  // A file that changes inside the share window is not seen yet.
  fs.appendFileSync(path.join(dir, 'a.jsonl'), usageLine('2', new Date().toISOString()) + '\n');
  clock.now += REFRESH_SHARE_MS - 1;
  await rows.refresh();
  assert.strictEqual(reads.length, 1);

  clock.now += 2;
  await rows.refresh();
  assert.strictEqual(reads.length, 2);
});

test('only files last modified before local midnight are written to the database', async () => {
  const { dir } = makeProjects();
  const old = writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  writeFile(dir, 'today', ['2'], 0);
  const store = openStore(tmpDb());
  const { refresh } = harness(dir, { store });

  await refresh();

  assert.deepStrictEqual(store.loadAll().map((e) => e.path), [old]);
  store.close();
});

test('a file written to the database is not written again while it is unchanged', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const store = openStore(tmpDb());
  let puts = 0;
  const realPut = store.put.bind(store);
  store.put = (...args) => {
    puts += 1;
    return realPut(...args);
  };
  const { refresh } = harness(dir, { store });

  await refresh();
  await refresh();

  assert.strictEqual(puts, 1);
  store.close();
});

test('rows stay after the transcript is deleted, and the database marks the file gone', async () => {
  const { dir } = makeProjects();
  const old = writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const store = openStore(tmpDb());
  const { rows, refresh } = harness(dir, { store });
  await refresh();

  fs.unlinkSync(old);
  await refresh();

  assert.strictEqual(rows.entries().length, 1);
  assert.strictEqual(rows.entries()[0].path, old);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
  assert.strictEqual(store.loadAll()[0].onDisk, false);
  store.close();
});

test('a deleted file that was never written to the database is dropped', async () => {
  const { dir } = makeProjects();
  const today = writeFile(dir, 'today', ['1']);
  const { rows, refresh } = harness(dir);
  await refresh();

  fs.unlinkSync(today);
  await refresh();

  assert.deepStrictEqual(rows.entries(), []);
});

test('with no database, rows live in memory only and a deleted file is dropped', async () => {
  const { dir } = makeProjects();
  const old = writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const { rows, refresh } = harness(dir, { store: null });
  await refresh();
  assert.strictEqual(rows.entries().length, 1);

  fs.unlinkSync(old);
  await refresh();
  assert.strictEqual(rows.entries().length, 0);
});

test('a restart with a populated database reads no file that is unchanged', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'old1', ['1'], 2 * DAY_MS);
  writeFile(dir, 'old2', ['2'], 3 * DAY_MS);
  const dbFile = tmpDb();
  const first = openStore(dbFile);
  await harness(dir, { store: first }).refresh();
  first.close();

  const second = openStore(dbFile);
  const { rows, reads, refresh } = harness(dir, { store: second });
  await refresh();

  assert.deepStrictEqual(reads, []);
  assert.strictEqual(rows.entries().length, 2);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
  second.close();
});

test('a stored file with an older extract version is read again when it is on disk', async () => {
  const { dir } = makeProjects();
  const old = writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const seed = openStore(dbFile);
  const st = fs.statSync(old);
  seed.put(old, { size: st.size, mtimeMs: st.mtimeMs, version: EXTRACT_VERSION - 1, onDisk: true, rows: { ...(await extractFile(old)), calls: [] } });
  seed.close();

  const store = openStore(dbFile);
  const { rows, reads, refresh } = harness(dir, { store });
  await refresh();

  assert.deepStrictEqual(reads, [old]);
  assert.strictEqual(rows.entries()[0].version, EXTRACT_VERSION);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
  assert.strictEqual(store.loadAll()[0].version, EXTRACT_VERSION, 'the new rows were written back');
  store.close();
});

test('a stored file whose transcript is gone keeps its older version and rows', async () => {
  const { dir } = makeProjects();
  const gone = path.join(dir, 'gone.jsonl');
  const dbFile = tmpDb();
  const seed = openStore(dbFile);
  seed.put(gone, { size: 1, mtimeMs: 1, version: EXTRACT_VERSION - 1, onDisk: false, rows: { ok: true, calls: [{ key: 'k' }], toolUses: [], errors: [], edits: [], prompts: [], sessions: {}, minT: 1, maxT: 1 } });
  seed.close();

  const store = openStore(dbFile);
  const { rows, reads, refresh } = harness(dir, { store });
  await refresh();

  assert.deepStrictEqual(reads, []);
  assert.strictEqual(rows.entries()[0].path, gone);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
  store.close();
});

test('entries come back with gone transcripts first, sorted by path, then files on disk', async () => {
  const { dir } = makeProjects();
  const b = writeFile(dir, 'b', ['1'], 2 * DAY_MS);
  const a = writeFile(dir, 'a', ['2'], 3 * DAY_MS);
  const live = writeFile(dir, 'live', ['3'], 0);
  const store = openStore(tmpDb());
  const { rows, refresh } = harness(dir, { store });
  await refresh();

  fs.unlinkSync(b);
  fs.unlinkSync(a);
  await refresh();

  assert.deepStrictEqual(rows.entries().map((e) => e.path), [a, b, live]);
  store.close();
});

test(
  'a file that cannot be read keeps its previous entry, and is read again on the next refresh',
  { skip: process.getuid?.() === 0 && 'root can read a mode-000 file' },
  async () => {
    const { dir } = makeProjects();
    const file = writeFile(dir, 'a', ['1']);
    const { rows, reads, refresh } = harness(dir);
    await refresh();

    fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
    fs.chmodSync(file, 0o000);
    try {
      await refresh();
      assert.strictEqual(rows.entries()[0].rows.calls.length, 1, 'the earlier rows are kept');
      assert.strictEqual(rows.entries()[0].rows.ok, true);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    await refresh();
    assert.strictEqual(reads.length, 3);
    assert.strictEqual(rows.entries()[0].rows.calls.length, 2);
  },
);

test(
  'a file that has never been read is listed as failed, and a later successful read replaces it',
  { skip: process.getuid?.() === 0 && 'root can read a mode-000 file' },
  async () => {
    const { dir } = makeProjects();
    const file = writeFile(dir, 'a', ['1']);
    fs.chmodSync(file, 0o000);
    const { rows, refresh } = harness(dir);
    try {
      await refresh();
      assert.strictEqual(rows.entries()[0].rows.ok, false);
    } finally {
      fs.chmodSync(file, 0o644);
    }

    await refresh(); // size and mtime are unchanged, so only the failure can trigger this read
    assert.strictEqual(rows.entries()[0].rows.ok, true);
    assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
  },
);

test('a failed database write is logged and the file is written on the next refresh', async (t) => {
  const { dir } = makeProjects();
  writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const warn = t.mock.method(console, 'warn', () => {});
  const written = [];
  let failures = 1;
  const store = {
    loadAll: () => [],
    put: (p) => written.push(p),
    markGone: () => {},
    transaction: (fn) => {
      if (failures-- > 0) throw new Error('disk full');
      fn();
    },
  };
  const { rows, refresh } = harness(dir, { store });

  await refresh();
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /disk full/);
  assert.deepStrictEqual(written, []);
  assert.strictEqual(rows.entries().length, 1, 'the dashboard keeps serving from memory');

  await refresh();
  assert.strictEqual(written.length, 1);
});

test('a stored file that is appended to is read again, and its stored rows are replaced once it is old again', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const store = openStore(tmpDb());
  const { rows, refresh } = harness(dir, { store });
  await refresh();
  assert.strictEqual(store.loadAll()[0].rows.calls.length, 1);

  // A resumed session appends to an ended file. The mtime is set back before
  // midnight so the file counts as settled again.
  fs.appendFileSync(file, usageLine('2', new Date(Date.now() - 2 * DAY_MS).toISOString()) + '\n');
  const seconds = (Date.now() - 2 * DAY_MS) / 1000;
  fs.utimesSync(file, seconds, seconds);
  await refresh();

  assert.strictEqual(rows.entries()[0].rows.calls.length, 2);
  const [stored] = store.loadAll();
  assert.strictEqual(stored.rows.calls.length, 2);
  assert.strictEqual(stored.size, fs.statSync(file).size);
  store.close();
});

test('a response copied into a live file counts once when its first copy is in a deleted transcript', async () => {
  const { dir } = makeProjects();
  const original = writeFile(dir, 'original', ['same'], 2 * DAY_MS);
  const store = openStore(tmpDb());
  const { rows, refresh } = harness(dir, { store });
  await refresh();
  fs.unlinkSync(original);

  // The resumed session copied the earlier line into its new file.
  writeFile(dir, 'resumed', ['same', 'new'], 0);
  await refresh();

  const data = aggregate(rows.entries().map((e) => e.rows), { days: null });
  assert.strictEqual(data.summary.apiCalls, 2);
  assert.strictEqual(data.summary.totalInput, 200);
  store.close();
});

// Reads the database the way a restart would, without the in-memory store.
function reload(dbFile) {
  const s = openStore(dbFile);
  const all = s.loadAll();
  s.close();
  return all;
}

function mockWarn() {
  const original = console.warn;
  console.warn = () => {};
  return { restore: () => { console.warn = original; } };
}

function failTransactionsOnce(store) {
  const real = store.transaction.bind(store);
  let failures = 1;
  store.transaction = (fn) => {
    if (failures-- > 0) throw new Error('busy');
    return real(fn);
  };
}

function assertStoredAsGone(rows, dbFile, file, calls) {
  const entry = rows.entries().find((e) => e.path === file);
  assert.ok(entry, 'the entry is still in memory');
  assert.strictEqual(entry.rows.calls.length, calls);
  assert.strictEqual(entry.onDisk, false);
  const [stored] = reload(dbFile);
  assert.strictEqual(stored.onDisk, false);
  assert.strictEqual(stored.rows.calls.length, calls);
}

test('a stored file appended to today and then deleted keeps its newest rows', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const { rows, refresh } = harness(dir, { store });
  await refresh();

  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await refresh();
  fs.unlinkSync(file);
  await refresh();

  assertStoredAsGone(rows, dbFile, file, 2);
  store.close();
});

test('a gone file that reappears with new content and is deleted again keeps its newest rows', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'b', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const { rows, refresh } = harness(dir, { store });
  await refresh();
  const saved = fs.readFileSync(file);
  fs.unlinkSync(file);
  await refresh();

  fs.writeFileSync(file, saved);
  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await refresh();
  fs.unlinkSync(file);
  await refresh();

  assertStoredAsGone(rows, dbFile, file, 2);
  store.close();
});

test('a stored file whose write failed and which is then deleted is written as gone', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'e', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const { rows, refresh } = harness(dir, { store });
  await refresh();

  fs.appendFileSync(file, usageLine('2', new Date(Date.now() - 2 * DAY_MS).toISOString()) + '\n');
  const seconds = (Date.now() - 2 * DAY_MS) / 1000 + 5;
  fs.utimesSync(file, seconds, seconds);
  const warn = mockWarn();
  failTransactionsOnce(store);
  await refresh();
  fs.unlinkSync(file);
  await refresh();
  warn.restore();

  assertStoredAsGone(rows, dbFile, file, 2);
  store.close();
});

test('a gone mark inside a failed transaction is written on the next refresh', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'c', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const { rows, refresh } = harness(dir, { store });
  await refresh();

  fs.unlinkSync(file);
  const warn = mockWarn();
  failTransactionsOnce(store);
  await refresh();
  assert.strictEqual(reload(dbFile)[0].onDisk, true, 'the failed transaction wrote nothing');
  await refresh();
  warn.restore();

  assertStoredAsGone(rows, dbFile, file, 1);
  store.close();
});

test(
  'an unreadable projects root leaves the entries, generation and database untouched',
  { skip: process.getuid?.() === 0 && 'root can list a mode-000 directory' },
  async (t) => {
    const { base, dir } = makeProjects();
    writeFile(dir, 'old', ['1'], 2 * DAY_MS);
    const real = openStore(tmpDb());
    t.after(() => real.close());
    const calls = [];
    const store = {
      loadAll: () => real.loadAll(),
      put: (p, e) => { calls.push('put'); real.put(p, e); },
      markGone: (p) => { calls.push('markGone'); real.markGone(p); },
      transaction: (fn) => real.transaction(fn),
    };
    const { rows, refresh } = harness(path.join(base, 'projects'), { store });
    await refresh();
    const entries = rows.entries();
    const generation = rows.generation;
    assert.strictEqual(entries.length, 1);
    calls.length = 0;

    const root = path.join(base, 'projects');
    fs.chmodSync(root, 0o000);
    t.after(() => fs.chmodSync(root, 0o755));
    await refresh();
    assert.deepStrictEqual(rows.entries(), entries);
    assert.strictEqual(rows.generation, generation);
    assert.deepStrictEqual(calls, []);

    fs.chmodSync(root, 0o755);
    await refresh();
    assert.deepStrictEqual(calls, [], 'nothing is written again once the root is readable');
    assert.strictEqual(rows.generation, generation);
  },
);

// A harness whose extract throws for the paths in `broken`, and reads the rest.
function throwingHarness(dir, broken) {
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    now: () => clock.now,
    extract: (file) => {
      if (broken.has(file)) throw new Error('extract bug');
      return extractFile(file);
    },
  });
  const refresh = async () => {
    clock.now += REFRESH_SHARE_MS + 1;
    await rows.refresh();
  };
  return { rows, refresh };
}

test('a file whose extract throws counts as unreadable, the others load, and it warns once', async (t) => {
  const { dir } = makeProjects();
  const bad = writeFile(dir, 'a', ['1']);
  const good = writeFile(dir, 'b', ['2']);
  const warn = t.mock.method(console, 'warn', () => {});
  const { rows, refresh } = throwingHarness(dir, new Set([bad]));

  await refresh();
  await refresh();
  await refresh();

  const byPath = new Map(rows.entries().map((e) => [e.path, e]));
  assert.strictEqual(byPath.get(bad).rows.ok, false);
  assert.deepStrictEqual(byPath.get(bad).rows.calls, []);
  assert.strictEqual(byPath.get(good).rows.calls.length, 1);
  const extractWarnings = warn.mock.calls.filter((c) => String(c.arguments[0]).includes(bad));
  assert.strictEqual(extractWarnings.length, 1);
  assert.strictEqual(extractWarnings[0].arguments[1].message, 'extract bug');
});

test('a file that loaded and then throws after a change keeps its previous rows', async (t) => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1']);
  t.mock.method(console, 'warn', () => {});
  const broken = new Set();
  const { rows, refresh } = throwingHarness(dir, broken);

  await refresh();
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);

  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  broken.add(file);
  await refresh();

  assert.strictEqual(rows.entries()[0].rows.ok, true);
  assert.strictEqual(rows.entries()[0].rows.calls.length, 1);
});

test('a growing file that keeps throwing warns once', async (t) => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1']);
  const warn = t.mock.method(console, 'warn', () => {});
  const { refresh } = throwingHarness(dir, new Set([file]));

  await refresh();
  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await refresh();
  fs.appendFileSync(file, usageLine('3', new Date().toISOString()) + '\n');
  await refresh();

  assert.strictEqual(warn.mock.calls.filter((c) => String(c.arguments[0]).includes(file)).length, 1);
});

test('a file that extracts cleanly after throwing warns again when it next throws', async (t) => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1']);
  const warn = t.mock.method(console, 'warn', () => {});
  const broken = new Set([file]);
  const { refresh } = throwingHarness(dir, broken);

  await refresh();
  broken.delete(file);
  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await refresh();
  broken.add(file);
  fs.appendFileSync(file, usageLine('3', new Date().toISOString()) + '\n');
  await refresh();

  assert.strictEqual(warn.mock.calls.filter((c) => String(c.arguments[0]).includes(file)).length, 2);
});
