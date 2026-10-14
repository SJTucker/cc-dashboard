'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createRowStore, REFRESH_SHARE_MS, formatBytes, formatElapsed } = require('../lib/rowstore');
const { extractFile, EXTRACT_VERSION } = require('../lib/extract');
const { openStore } = require('../lib/store');
const { aggregate } = require('../lib/aggregate');
const sqlite = require('../lib/sqlite');

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
function harness(dir, { store = null, log, agentUsageDir } = {}) {
  const reads = [];
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    agentUsageDir: () => agentUsageDir ?? null,
    store,
    log,
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

// Writes a step file as the mod does. `ageMs` sets its mtime that far in the past.
function writeSteps(dir, agentId, steps, ageMs = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.json`);
  fs.writeFileSync(file, JSON.stringify({ agentId, steps }));
  const seconds = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}
const STEP = { t: Date.now(), model: 'claude-sonnet-4-6', input: 2, cacheWrite: 10, cacheRead: 20, output: 300, turnId: 't1', index: 0 };
const stepEntries = (rows) => rows.entries().filter((e) => e.rows.agentSteps);

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

test('version 1 rows: a file on disk is read again for its command rows, and a gone file aggregates without them', async () => {
  const { dir } = makeProjects();
  const onDisk = path.join(dir, 'ondisk.jsonl');
  const twoDaysAgo = Date.now() - 2 * DAY_MS;
  const line = { type: 'user', sessionId: 's1', uuid: 'u1', timestamp: new Date(twoDaysAgo).toISOString(), message: { content: '<command-message>tdd</command-message>\n<command-name>/tdd</command-name>' } };
  fs.writeFileSync(onDisk, JSON.stringify(line) + '\n');
  fs.utimesSync(onDisk, twoDaysAgo / 1000, twoDaysAgo / 1000);
  const gone = path.join(dir, 'gone.jsonl');
  const v1 = { ok: true, calls: [], toolUses: [], errors: [], edits: [], prompts: [], sessions: {}, minT: 1, maxT: 1 };
  const goneCall = { key: 'k', t: 1, sessionId: 's2', sidechain: false, model: 'claude-sonnet-4-6', version: null, usage: { input_tokens: 100, output_tokens: 50 }, attributionSkill: 'tdd', attributionAgent: null, tools: [] };
  const dbFile = tmpDb();
  const seed = openStore(dbFile);
  const st = fs.statSync(onDisk);
  seed.put(onDisk, { size: st.size, mtimeMs: st.mtimeMs, version: 1, onDisk: true, rows: v1 });
  seed.put(gone, { size: 1, mtimeMs: 1, version: 1, onDisk: false, rows: { ...v1, calls: [goneCall] } });
  seed.close();

  const store = openStore(dbFile);
  const { rows, reads, refresh } = harness(dir, { store });
  await refresh();

  assert.deepStrictEqual(reads, [onDisk], 'only the file on disk is read again');
  const byPath = new Map(rows.entries().map((e) => [e.path, e.rows]));
  assert.deepStrictEqual(byPath.get(onDisk).commands.map((c) => c.name), ['tdd']);
  assert.deepStrictEqual(byPath.get(gone).commands, [], 'a deleted transcript cannot be read for command rows, so its migration adds none');
  const data = aggregate(rows.entries().map((e) => e.rows), { days: null });
  assert.deepStrictEqual(data.skills.map((r) => [r.name, r.invocations]), [['tdd', 1]]);
  store.close();
});

test('version 2 rows: a file on disk is read again and its tool uses gain the model', async () => {
  const { dir } = makeProjects();
  const file = path.join(dir, 'v2.jsonl');
  const twoDaysAgo = Date.now() - 2 * DAY_MS;
  const line = {
    type: 'assistant', sessionId: 's1', requestId: 'r1', timestamp: new Date(twoDaysAgo).toISOString(),
    message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  };
  fs.writeFileSync(file, JSON.stringify(line) + '\n');
  fs.utimesSync(file, twoDaysAgo / 1000, twoDaysAgo / 1000);
  const dbFile = tmpDb();
  const seed = openStore(dbFile);
  const st = fs.statSync(file);
  const v2 = await extractFile(file);
  seed.put(file, { size: st.size, mtimeMs: st.mtimeMs, version: 2, onDisk: true, rows: { ...v2, toolUses: v2.toolUses.map(({ model, ...rest }) => rest) } });
  seed.close();

  const store = openStore(dbFile);
  const { rows, reads, refresh } = harness(dir, { store });
  await refresh();

  assert.deepStrictEqual(reads, [file]);
  assert.strictEqual(rows.entries()[0].rows.toolUses[0].model, 'claude-opus-5-5');
  store.close();
});

test('version 1 rows of a deleted transcript get each tool use model from its calls', async () => {
  const { dir } = makeProjects();
  const gone = path.join(dir, 'gone.jsonl');
  const goneCall = { key: 'k', t: 5, sessionId: 's2', sidechain: false, model: 'claude-opus-5', version: null, usage: { input_tokens: 1, output_tokens: 1 }, attributionSkill: null, attributionAgent: null, tools: ['Bash'] };
  const v1 = { ok: true, calls: [goneCall], toolUses: [{ key: 'toolu_g', t: 5, name: 'Bash', detail: 'ls' }], errors: [], edits: [], prompts: [], sessions: {}, minT: 5, maxT: 5 };
  const dbFile = tmpDb();
  const seed = openStore(dbFile);
  seed.put(gone, { size: 1, mtimeMs: 1, version: 1, onDisk: false, rows: v1 });
  seed.close();

  const store = openStore(dbFile);
  const { rows, reads, refresh } = harness(dir, { store });
  await refresh();

  assert.deepStrictEqual(reads, [], 'a deleted transcript is not read');
  const data = aggregate(rows.entries().map((e) => e.rows), { days: null });
  assert.deepStrictEqual(data.tools[0].byModel.map((m) => [m.label, m.calls]), [['Opus 5', 1]]);
  store.close();
});

const HOUR_MS = 60 * 60 * 1000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Moves a file's mtime one second later, which makes its stored entry out of date.
function bump(file) {
  const seconds = fs.statSync(file).mtimeMs / 1000 + 1;
  fs.utimesSync(file, seconds, seconds);
}

// A row store whose extract is gatedExtract() (test/helpers.js). `clock` is the
// store's `now`. With `pool`, the files are asked for through a fake pool all at once,
// as the worker pool does, instead of one after another.
function gatedStore(dir, { store = null, pool = false } = {}) {
  const g = helpers.gatedExtract();
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    store,
    now: () => clock.now,
    ...(pool ? { openPool: (size, fn) => fn({ extract: g.extract, started: Promise.resolve(true) }), poolLimits: { files: 0, bytes: 0 } } : { extract: g.extract }),
  });
  return { rows, reads: g.reads, ctl: g.ctl, clock, release: g.release };
}

test('out-of-date files are read in descending mtime order', async () => {
  const { dir } = makeProjects();
  const mid = writeFile(dir, 'a-mid', ['1'], 2 * HOUR_MS);
  const old = writeFile(dir, 'b-old', ['2'], 3 * DAY_MS);
  const fresh = writeFile(dir, 'c-new', ['3'], 0);
  const { reads, refresh } = harness(dir);

  await refresh();

  assert.deepStrictEqual(reads, [fresh, mid, old]);
});

test('entries() lists files on disk in walk order whatever order they were read in', async () => {
  const { findJsonlFiles } = require('../lib/transcript-files');
  const { dir } = makeProjects();
  writeFile(dir, 'a-old', ['1'], 3 * DAY_MS);
  writeFile(dir, 'b-new', ['2'], 0);
  writeFile(dir, 'c-mid', ['3'], 2 * HOUR_MS);
  const { rows, refresh } = harness(dir);

  await refresh();

  assert.deepStrictEqual(rows.entries().map((e) => e.path), findJsonlFiles(dir));
});

test('entries() holds only files that have an entry while a run reads new files', async () => {
  const { findJsonlFiles } = require('../lib/transcript-files');
  const { dir } = makeProjects();
  const fresh = writeFile(dir, 'a', ['1'], 0);
  const old = writeFile(dir, 'b', ['2'], 2 * DAY_MS);
  const g = gatedStore(dir);
  g.ctl.hold = true;

  const run = g.rows.refresh();
  assert.deepStrictEqual(g.rows.entries(), [], 'no file has been read yet');

  g.release(fresh);
  await tick();
  assert.deepStrictEqual(g.rows.entries().map((e) => e.path), [fresh]);
  assert.ok(g.rows.entries().every((e) => e !== undefined));

  g.release(old);
  await run;
  assert.deepStrictEqual(g.rows.entries().map((e) => e.path), findJsonlFiles(dir));
});

test('generation goes up as each file is loaded during a run', async () => {
  const { dir } = makeProjects();
  const fresh = writeFile(dir, 'a', ['1'], 0);
  const old = writeFile(dir, 'b', ['2'], 2 * DAY_MS);
  const g = gatedStore(dir);
  g.ctl.hold = true;
  const start = g.rows.generation;

  const run = g.rows.refresh();
  g.release(fresh);
  await tick();
  const afterFirst = g.rows.generation;
  assert.ok(afterFirst > start, 'the newest file is in, the older one is still being read');

  g.release(old);
  await run;
  assert.ok(g.rows.generation > afterFirst);
});

test('a file that grows after the stat pass keeps the stat-pass size and is read again on the next refresh', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1'], 2 * HOUR_MS);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [];
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    now: () => clock.now,
    extract: async (f) => {
      reads.push(f);
      if (reads.length === 1) await gate;
      return extractFile(f);
    },
  });

  const run = rows.refresh();
  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  release();
  await run;
  assert.strictEqual(rows.entries()[0].rows.calls.length, 2, 'the read sees the whole file');

  clock.now += REFRESH_SHARE_MS + 1;
  await rows.refresh();
  assert.strictEqual(reads.length, 2, 'the entry holds the smaller size, so the file is out of date');
});

// A stand-in for withPool that counts the pools it opens and runs files through `extract`.
function fakePool(extract) {
  const opened = [];
  const openPool = (size, fn) => {
    opened.push(size);
    return fn({ extract, started: Promise.resolve(true) });
  };
  return { opened, openPool };
}

test('a run with few files, or few bytes, reads on the main thread', async () => {
  const { dir } = makeProjects();
  for (let i = 0; i < 3; i++) writeFile(dir, `f${i}`, [String(i)], 2 * DAY_MS);
  const pool = fakePool(extractFile);
  const reads = [];
  const read = (file) => { reads.push(file); return extractFile(file); };
  // Three files do not pass the file limit, and their few bytes do not pass the byte limit.
  const few = createRowStore({ projectsDir: () => dir, openPool: pool.openPool, poolLimits: { files: 3, bytes: 0 }, extract: read });
  await few.refresh();
  const small = createRowStore({ projectsDir: () => dir, openPool: pool.openPool, poolLimits: { files: 0, bytes: 1e9 }, extract: read });
  await small.refresh();
  assert.deepStrictEqual(pool.opened, []);
  assert.strictEqual(reads.length, 6);
});

test('a run over both limits opens one pool of poolSize() workers and reads every file through it', async () => {
  const { poolSize } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const files = [0, 1, 2].map((i) => writeFile(dir, `f${i}`, [String(i)], 2 * DAY_MS + i * HOUR_MS));
  const viaPool = [];
  const pool = fakePool((file) => { viaPool.push(file); return extractFile(file); });
  const rows = createRowStore({ projectsDir: () => dir, openPool: pool.openPool, poolLimits: { files: 2, bytes: 0 } });

  await rows.refresh();

  assert.deepStrictEqual(pool.opened, [Math.min(poolSize(), 3)]);
  assert.deepStrictEqual(viaPool, files, 'dispatched newest first');
  assert.strictEqual(rows.entries().length, 3);
});

test('an injected extract is used whatever the limits are, and no pool starts', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1'], 2 * DAY_MS);
  const reads = [];
  const rows = createRowStore({
    projectsDir: () => dir,
    poolLimits: { files: 0, bytes: 0 },
    extract: (f) => { reads.push(f); return extractFile(f); },
  });

  await rows.refresh();

  assert.deepStrictEqual(reads, [file]);
});

test('rows read by real worker threads equal the rows read on the main thread', async () => {
  const { withPool } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const files = [0, 1, 2].map((i) => writeFile(dir, `f${i}`, [String(i), `${i}b`], 2 * DAY_MS + i * HOUR_MS));
  let pools = 0;
  const rows = createRowStore({
    projectsDir: () => dir,
    openPool: (size, fn) => { pools += 1; return withPool(size, fn); },
    poolLimits: { files: 0, bytes: 0 },
  });

  await rows.refresh();

  assert.strictEqual(pools, 1, 'the files were read through a real pool');
  for (const entry of rows.entries()) {
    assert.deepStrictEqual(entry.rows, await extractFile(entry.path));
    assert.strictEqual(Object.getPrototypeOf(entry.rows.sessions), null);
  }
  assert.strictEqual(rows.entries().length, files.length);
});

test('a file the pool could not read keeps its previous entry, and the others are still read', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { failedRows } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const a = writeFile(dir, 'a', ['1'], 2 * HOUR_MS);
  const b = writeFile(dir, 'b', ['2'], 3 * HOUR_MS);
  const failing = new Set();
  const pool = fakePool((file) => (failing.has(file) ? Promise.resolve(failedRows()) : extractFile(file)));
  const clock = { now: Date.now() };
  const rows = createRowStore({ projectsDir: () => dir, now: () => clock.now, openPool: pool.openPool, poolLimits: { files: 0, bytes: 0 } });
  await rows.refresh();

  fs.appendFileSync(a, usageLine('3', new Date().toISOString()) + '\n');
  fs.appendFileSync(b, usageLine('4', new Date().toISOString()) + '\n');
  failing.add(b);
  clock.now += REFRESH_SHARE_MS + 1;
  await rows.refresh();

  const byPath = Object.fromEntries(rows.entries().map((e) => [e.path, e.rows]));
  assert.strictEqual(byPath[a].calls.length, 2, 'the readable file is updated');
  assert.strictEqual(byPath[b].calls.length, 1, 'the failed file keeps its earlier rows');
  assert.strictEqual(byPath[b].ok, true);
});

// Two files, `fresh` newer than `held`. The one-worker pool reads the newest file of a
// run first and dies on the next, so `held` is the file whose worker dies whenever
// `fresh` is also out of date. bump(fresh) before a run keeps it newest.
function dyingWorkerStore(t, limits) {
  const warn = t.mock.method(console, 'warn', () => {});
  const { withPool } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const held = writeFile(dir, 'b', ['2'], 3 * HOUR_MS);
  const fresh = writeFile(dir, 'a', ['1'], 2 * HOUR_MS);
  const mainReads = [];
  const extract = (f) => { mainReads.push(f); return extractFile(f); };
  const workerFile = path.join(__dirname, 'fixtures', 'die-after-first-worker.js');
  const openPool = (size, fn) => withPool(1, fn, { workerFile });
  const clock = { now: Date.now() };
  const rows = createRowStore({ projectsDir: () => dir, now: () => clock.now, extract, openPool, poolLimits: limits });
  const refresh = async () => {
    clock.now += REFRESH_SHARE_MS + 1;
    await rows.refresh();
  };
  const byPath = () => Object.fromEntries(rows.entries().map((e) => [e.path, e.rows]));
  return { rows, held, fresh, mainReads, refresh, byPath, warn };
}

test('a file whose worker died is read again through a worker, and counts once that read succeeds', async (t) => {
  const limits = { files: 0, bytes: 0 };
  const { held, mainReads, refresh, byPath } = dyingWorkerStore(t, limits);

  await refresh(); // run 1: the worker reads `fresh`, then dies on `held`
  assert.strictEqual(byPath()[held].ok, false);

  limits.files = 99; // below the pool limits, but `held` has a death on record
  await refresh(); // run 2: `held` alone is out of date, and a fresh worker reads it
  assert.deepStrictEqual(mainReads, [], 'the retry runs on a worker, never on the main thread');
  assert.strictEqual(byPath()[held].ok, true);
  assert.strictEqual(byPath()[held].calls.length, 1);
});

test('a file whose worker died 3 times is not read again, on a worker or the main thread, until its size or mtime changes', async (t) => {
  const limits = { files: 0, bytes: 0 };
  const { held, fresh, mainReads, refresh, byPath, warn } = dyingWorkerStore(t, limits);
  const capWarnings = () => warn.mock.calls.filter((c) => /stopped a worker 3 times/.test(c.arguments[0]));

  await refresh(); // death 1
  limits.files = 99;
  for (const death of [2, 3]) {
    bump(fresh); // newest again, so the worker reads it first and dies on `held`
    await refresh();
    assert.strictEqual(byPath()[held].ok, false, `death ${death}`);
  }
  assert.deepStrictEqual(mainReads, [], 'no death sent the file to the main thread');
  assert.strictEqual(capWarnings().length, 1);
  assert.strictEqual(
    capWarnings()[0].arguments[0],
    `[rowstore] ${held} stopped a worker 3 times. It counts as unreadable until its size or mtime changes.`,
  );

  bump(fresh);
  await refresh(); // `fresh` is read on the main thread, `held` is skipped
  assert.deepStrictEqual(mainReads, [fresh], 'the file at the cap is not read');
  assert.strictEqual(byPath()[held].ok, false, 'it still counts as unreadable');
  assert.ok(!('workerDied' in byPath()[held]));
  assert.strictEqual(capWarnings().length, 1, 'the cap is logged once');

  bump(held); // a changed file is read again
  await refresh();
  assert.deepStrictEqual(mainReads, [fresh, held]);
  assert.strictEqual(byPath()[held].ok, true);
});

test('a file at the death cap with no earlier good entry does not move generation on later refreshes', async (t) => {
  const limits = { files: 0, bytes: 0 };
  const { held, fresh, rows, refresh } = dyingWorkerStore(t, limits);
  await refresh();
  limits.files = 99;
  for (const death of [2, 3]) {
    bump(fresh);
    await refresh();
  }
  assert.strictEqual(rows.entries().find((e) => e.path === held).rows.ok, false);

  await refresh(); // nothing changed on disk since the cap
  const before = rows.generation;
  await refresh();
  await refresh();
  assert.strictEqual(rows.generation, before, 'a skipped file changes nothing');
});

test('a file with a death count is never read on the main thread, even when the pool never starts', async (t) => {
  const { failedRows, withPool } = require('../lib/extract-pool');
  t.mock.method(console, 'warn', () => {});
  const { dir } = makeProjects();
  const held = writeFile(dir, 'b', ['2'], 3 * HOUR_MS);
  const fresh = writeFile(dir, 'a', ['1'], 2 * HOUR_MS);
  const mainReads = [];
  const extract = (f) => { mainReads.push(f); return extractFile(f); };
  const workerFile = path.join(__dirname, 'fixtures', 'die-after-first-worker.js');
  const limits = { files: 99, bytes: 0 };
  let openPool = (size, fn) => withPool(1, fn, { workerFile });
  const clock = { now: Date.now() };
  const rows = createRowStore({ projectsDir: () => dir, now: () => clock.now, extract, openPool: (size, fn) => openPool(size, fn), poolLimits: limits });
  const refresh = async () => {
    clock.now += REFRESH_SHARE_MS + 1;
    await rows.refresh();
  };
  const entry = (file) => rows.entries().find((e) => e.path === file);
  // Run 1 reads both files on the main thread. Make both out of date, then let a worker die on `held`.
  await refresh();
  mainReads.length = 0;
  bump(fresh);
  bump(held);
  limits.files = 0;
  await refresh(); // `fresh` read by the worker, `held` killed it: count 1
  assert.deepStrictEqual(mainReads, []);

  // The pool never starts and fails the file: this is a second death, not a main-thread read.
  openPool = (size, fn) => fn({ extract: () => Promise.resolve(failedRows()), started: Promise.resolve(false) });
  await refresh();
  assert.ok(!mainReads.includes(held), 'the file with a count stays off the main thread');
  assert.ok(entry(held).rows.ok, 'its earlier good rows stay');

  // One more death reaches the cap, and a cap-level file is skipped without any read.
  await refresh();
  const warnings = console.warn.mock.calls.filter((c) => /stopped a worker 3 times/.test(c.arguments[0]));
  assert.strictEqual(warnings.length, 1, 'the count went 1, 2, 3');
  assert.ok(!mainReads.includes(held));
});

test('a file that changes after a worker death loses its death count', async (t) => {
  const limits = { files: 0, bytes: 0 };
  const { held, fresh, mainReads, refresh, byPath } = dyingWorkerStore(t, limits);
  await refresh(); // death 1
  limits.files = 99;
  bump(fresh);
  await refresh(); // death 2

  bump(held); // changed, so it has a new key and its old count of 2 no longer applies (the prune only
  // stops the Map from growing); the small run reads it on the main thread
  bump(fresh);
  await refresh();
  assert.deepStrictEqual(mainReads, [fresh, held], 'a file with a count would have gone to a worker');
  assert.strictEqual(byPath()[held].ok, true);
});

test('when worker threads cannot run, the files are extracted on the main thread and the store has current entries', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { withPool } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const files = [0, 1, 2].map((i) => writeFile(dir, `f${i}`, [String(i)], 2 * DAY_MS + i * HOUR_MS));
  const workerFile = path.join(__dirname, 'fixtures', 'exit-worker.js');
  const rows = createRowStore({
    projectsDir: () => dir,
    openPool: (size, fn) => withPool(2, fn, { workerFile }),
    poolLimits: { files: 0, bytes: 0 },
  });

  await rows.refresh();

  const entries = rows.entries();
  assert.deepStrictEqual(entries.map((e) => e.path), files.slice().sort());
  assert.ok(entries.every((e) => e.rows.ok && e.rows.calls.length === 1));
  assert.ok(entries.every((e) => e.version === EXTRACT_VERSION));
});

test('after a worker has returned a result, a worker that dies leaves its file failed and the previous entry stays', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { withPool } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const files = [0, 1, 2].map((i) => writeFile(dir, `f${i}`, [String(i)], 2 * HOUR_MS + i * HOUR_MS));
  const workerFile = path.join(__dirname, 'fixtures', 'die-after-first-worker.js');
  const limits = { files: 99, bytes: 0 };
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    now: () => clock.now,
    openPool: (size, fn) => withPool(1, fn, { workerFile }),
    poolLimits: limits,
  });
  await rows.refresh(); // three files, under the file limit: read on the main thread

  // The first file is the newest, so it is the one the single worker reads before it dies.
  files.forEach((file, i) => {
    fs.appendFileSync(file, usageLine(`x${i}`, new Date().toISOString()) + '\n');
    const seconds = Date.now() / 1000 - i * 60;
    fs.utimesSync(file, seconds, seconds);
  });
  limits.files = 0;
  clock.now += REFRESH_SHARE_MS + 1;
  await rows.refresh();

  const byPath = Object.fromEntries(rows.entries().map((e) => [e.path, e.rows]));
  assert.deepStrictEqual(files.map((f) => byPath[f].calls.length), [2, 1, 1], 'only the newest file was read before the worker died');
  assert.ok(files.every((f) => byPath[f].ok));
});

test('after a worker died, the next refresh reads the file it was reading and the file queued behind it, on a worker', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { withPool } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const files = [0, 1, 2].map((i) => writeFile(dir, `f${i}`, [String(i)], 2 * HOUR_MS + i * HOUR_MS));
  const workerFile = path.join(__dirname, 'fixtures', 'die-after-first-worker.js');
  const limits = { files: 99, bytes: 0 };
  const clock = { now: Date.now() };
  const mainReads = [];
  const extract = (f) => { mainReads.push(f); return extractFile(f); };
  const rows = createRowStore({ projectsDir: () => dir, now: () => clock.now, extract, openPool: (size, fn) => withPool(1, fn, { workerFile }), poolLimits: limits });
  await rows.refresh();
  files.forEach((file, i) => {
    fs.appendFileSync(file, usageLine(`x${i}`, new Date().toISOString()) + '\n');
    const seconds = Date.now() / 1000 - i * 60;
    fs.utimesSync(file, seconds, seconds);
  });
  limits.files = 0;
  clock.now += REFRESH_SHARE_MS + 1;
  await rows.refresh(); // f0 read by the worker, f1 killed it, f2 never attempted

  mainReads.length = 0;
  limits.files = 99;
  clock.now += REFRESH_SHARE_MS + 1;
  await rows.refresh();
  assert.deepStrictEqual(mainReads, [], 'f1 and f2 are both retried, on a worker');
  assert.ok(rows.entries().find((e) => e.path === files[1]).rows.ok, 'f1 reads on the retry');
});

test('a failed result without a worker death does not count a worker death', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { failedRows } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const file = writeFile(dir, 'a', ['1'], 2 * HOUR_MS);
  const mainReads = [];
  const extract = (f) => { mainReads.push(f); return extractFile(f); };
  const limits = { files: 0, bytes: 0 };
  const openPool = (size, fn) => fn({ extract: () => Promise.resolve(failedRows()), started: Promise.resolve(true) });
  const clock = { now: Date.now() };
  const rows = createRowStore({ projectsDir: () => dir, now: () => clock.now, extract, openPool, poolLimits: limits });
  await rows.refresh();
  limits.files = 99;
  clock.now += REFRESH_SHARE_MS + 1;
  await rows.refresh();
  assert.deepStrictEqual(mainReads, [file], 'retried on the next refresh');
});

// True when `promise` settles within 200 ms.
const settlesSoon = (promise) => Promise.race([promise.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 200))]);

// Four transcripts that already have entries, and are then modified so that each one
// is out of date. Their ages are 0, 1 hour, 3 days and 20 days. The store holds from
// here on, so a read waits for release(file).
async function staleFiles(g, dir) {
  const files = {
    today: writeFile(dir, 'a-today', ['1'], 0),
    hour: writeFile(dir, 'b-hour', ['2'], HOUR_MS),
    week: writeFile(dir, 'c-week', ['3'], 3 * DAY_MS),
    old: writeFile(dir, 'd-old', ['4'], 20 * DAY_MS),
  };
  await g.rows.refresh();
  for (const file of Object.values(files)) bump(file);
  g.clock.now += REFRESH_SHARE_MS + 1;
  g.ctl.hold = true;
  return files;
}

test('refresh({ since }) resolves once the out-of-date files at or after since are loaded, before the older ones', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const g = gatedStore(dir);
  const f = await staleFiles(g, dir);
  const phaseOneReads = g.reads.length;
  let resolved = false;

  const waiting = g.rows.refresh({ since: Date.now() - 2 * HOUR_MS }).then(() => { resolved = true; });
  g.release(f.today);
  await tick();
  assert.strictEqual(resolved, false, 'the file modified an hour ago is still being read');

  g.release(f.hour);
  await waiting;
  assert.ok(!g.reads.slice(phaseOneReads).includes(f.old), 'the 20-day-old file has not been read');

  g.release(f.week);
  g.release(f.old);
  await g.rows.refresh();
});

test('refresh({ since }) does not resolve early when loads finish out of dispatch order', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const g = gatedStore(dir, { pool: true });
  const f = await staleFiles(g, dir);
  const phaseOneReads = g.reads.length;
  let resolved = false;

  const waiting = g.rows.refresh({ since: Date.now() - 2 * HOUR_MS }).then(() => { resolved = true; });
  assert.deepStrictEqual(g.reads.slice(phaseOneReads), [f.today, f.hour, f.week, f.old], 'every file is asked for at once, newest first');

  g.release(f.hour);
  g.release(f.old);
  await tick();
  assert.strictEqual(resolved, false, 'two files are loaded but the newest is not');

  g.release(f.today);
  await waiting;
  g.release(f.week);
  await g.rows.refresh();
});

test('on a store with no entries, refresh({ since }) waits for every file', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const files = [writeFile(dir, 'a', ['1'], 0), writeFile(dir, 'b', ['2'], 3 * DAY_MS), writeFile(dir, 'c', ['3'], 20 * DAY_MS)];
  const g = gatedStore(dir);
  g.ctl.hold = true;
  let resolved = false;

  const waiting = g.rows.refresh({ since: Date.now() + DAY_MS }).then(() => { resolved = true; });
  g.release(files[0]);
  g.release(files[1]);
  await tick();
  assert.strictEqual(resolved, false, 'the 20-day-old file has no entry yet');

  g.release(files[2]);
  await waiting;
  assert.strictEqual(g.rows.entries().length, 3);
});

test('a file with no entry is waited for whatever its mtime, next to an out-of-date file that has one', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const g = gatedStore(dir, { pool: true });
  const today = writeFile(dir, 'a-today', ['1'], 0);
  const week = writeFile(dir, 'b-week', ['2'], 3 * DAY_MS);
  await g.rows.refresh();
  const fresh = writeFile(dir, 'c-new-old', ['3'], 5 * DAY_MS);
  bump(today);
  bump(week);
  g.clock.now += REFRESH_SHARE_MS + 1;
  g.ctl.hold = true;
  let resolved = false;

  const waiting = g.rows.refresh({ since: Date.now() - 2 * HOUR_MS }).then(() => { resolved = true; });
  g.release(today);
  await tick();
  assert.strictEqual(resolved, false, 'the new file is not loaded');

  g.release(fresh);
  await waiting;
  g.release(week);
  await g.rows.refresh();
});

test('a since later than every out-of-date file resolves once the stat pass is done', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const g = gatedStore(dir);
  const f = await staleFiles(g, dir);

  const waiting = g.rows.refresh({ since: Date.now() + DAY_MS });
  assert.strictEqual(await settlesSoon(waiting), true);

  for (const file of Object.values(f)) g.release(file);
  await g.rows.refresh();
});

test('a file whose mtime equals since is waited for', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const g = gatedStore(dir);
  const f = await staleFiles(g, dir);
  let resolved = false;

  const waiting = g.rows.refresh({ since: fs.statSync(f.hour).mtimeMs }).then(() => { resolved = true; });
  g.release(f.today);
  await tick();
  assert.strictEqual(resolved, false);

  g.release(f.hour);
  await waiting;
  g.release(f.week);
  g.release(f.old);
  await g.rows.refresh();
});

test('a caller that joins after its files have loaded resolves at once, and a run that finished under 2 s ago is reused', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const g = gatedStore(dir);
  const f = await staleFiles(g, dir);

  const run = g.rows.refresh();
  g.release(f.today);
  g.release(f.hour);
  await tick();
  const late = g.rows.refresh({ since: Date.now() - 2 * HOUR_MS });
  assert.strictEqual(await settlesSoon(late), true);

  g.release(f.week);
  g.release(f.old);
  await run;
  const readsAfterRun = g.reads.length;
  assert.strictEqual(await settlesSoon(g.rows.refresh({ since: 0 })), true);
  assert.strictEqual(g.reads.length, readsAfterRun, 'no new run started');
});

test('refresh({ since }) resolves before persist, and refresh() waits for it', { timeout: 5000 }, async () => {
  const { dir } = makeProjects();
  const store = openStore(tmpDb());
  let puts = 0;
  const realPut = store.put.bind(store);
  store.put = (...args) => {
    puts += 1;
    return realPut(...args);
  };
  const g = gatedStore(dir, { store });
  const f = await staleFiles(g, dir);
  const putsBefore = puts;

  const full = g.rows.refresh();
  const partial = g.rows.refresh({ since: Date.now() - 2 * HOUR_MS });
  g.release(f.today);
  g.release(f.hour);
  await partial;
  assert.strictEqual(puts, putsBefore, 'the 3-day and 20-day-old files are not read yet, so nothing is written');

  g.release(f.week);
  g.release(f.old);
  await full;
  assert.ok(puts >= putsBefore + 2, 'the two old files are written before refresh() resolves');
  store.close();
});

test('a run that throws rejects the callers that passed since, instead of leaving them waiting', { timeout: 5000 }, async () => {
  const rows = createRowStore({ projectsDir: () => { throw new Error('no projects root'); } });

  await assert.rejects(rows.refresh({ since: 0 }), /no projects root/);
  await assert.rejects(rows.refresh(), /no projects root/, 'the next refresh starts a new run');
});

// The lines a store logs. Pass `log` as the store's `log` option.
const logSpy = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

test('the first run logs one line with the files read, the files found, their size and the time, and later runs log nothing', async () => {
  const spy = logSpy();
  const { dir } = makeProjects();
  const a = writeFile(dir, 'a', ['1'], 2 * DAY_MS);
  writeFile(dir, 'b', ['2'], 3 * DAY_MS);
  const { rows, refresh } = harness(dir, { log: spy.log });

  await refresh();
  assert.strictEqual(spy.lines.length, 1);
  assert.match(spy.lines[0], /^\[rows\] Read 2 of 2 transcripts \(\d+ (B|KB)\) in \d+(\.\d)? (ms|s)$/);

  fs.appendFileSync(a, usageLine('3', new Date().toISOString()) + '\n');
  await refresh();
  assert.strictEqual(spy.lines.length, 1);
  assert.strictEqual(rows.entries().length, 2);
});

test('the line counts only the files that were out of date, and names the workers when a pool read them', async () => {
  const spy = logSpy();
  const { poolSize } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  const old = writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const first = openStore(dbFile);
  await harness(dir, { store: first }).refresh();
  first.close();
  fs.appendFileSync(old, usageLine('2', new Date().toISOString()) + '\n');
  writeFile(dir, 'fresh', ['3'], 0);

  const second = openStore(dbFile);
  const rows = createRowStore({ projectsDir: () => dir, store: second, log: spy.log, openPool: fakePool(extractFile).openPool, poolLimits: { files: 0, bytes: 0 } });
  await rows.refresh({ since: 0 });
  await rows.refresh();

  assert.strictEqual(spy.lines.length, 1);
  assert.match(spy.lines[0], new RegExp(`^\\[rows\\] Read 2 of 2 transcripts \\(\\d+ (B|KB)\\) in \\d+(\\.\\d)? (ms|s) with ${Math.min(poolSize(), 2)} workers?$`));
  second.close();
});

test('a refresh issued from a rejected refresh settles instead of joining the failed run', { timeout: 5000 }, async () => {
  const rows = createRowStore({ projectsDir: () => { throw new Error('no projects dir'); } });
  const second = await rows.refresh({ since: 0 }).then(() => 'resolved', () => rows.refresh({ since: 0 }).then(() => 'resolved', (err) => `rejected: ${err.message}`));
  assert.match(second, /^(resolved|rejected)/);
});

test('after the main-thread fallback the startup line names no workers', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { withPool } = require('../lib/extract-pool');
  const { dir } = makeProjects();
  [0, 1, 2].forEach((i) => writeFile(dir, `f${i}`, [String(i)], 2 * DAY_MS + i * HOUR_MS));
  const lines = [];
  const rows = createRowStore({
    projectsDir: () => dir,
    log: (line) => lines.push(line),
    openPool: (size, fn) => withPool(2, fn, { workerFile: path.join(__dirname, 'fixtures', 'exit-worker.js') }),
    poolLimits: { files: 0, bytes: 0 },
  });
  await rows.refresh();
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^\[rows\] Read 3 of 3 transcripts/);
  assert.doesNotMatch(lines[0], / with /);
});

test('the pool is opened with no more workers than files', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'only', ['1'], 2 * DAY_MS);
  const sizes = [];
  const pool = fakePool(extractFile);
  const rows = createRowStore({ projectsDir: () => dir, openPool: (size, fn) => { sizes.push(size); return pool.openPool(size, fn); }, poolLimits: { files: 0, bytes: 0 } });
  await rows.refresh();
  assert.deepStrictEqual(sizes, [1]);
});

test('a store with no log option prints nothing', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { dir } = makeProjects();
  writeFile(dir, 'a', ['1'], 2 * DAY_MS);
  await harness(dir).refresh();
  assert.strictEqual(log.mock.callCount(), 0);
});

test('the startup line writes sizes and times in the units a reader expects', () => {
  assert.strictEqual(formatBytes(1.8 * 1024 ** 3), '1.8 GB');
  assert.strictEqual(formatBytes(23 * 1024 ** 2), '23 MB');
  assert.strictEqual(formatBytes(412 * 1024), '412 KB');
  assert.strictEqual(formatBytes(90), '90 B');
  assert.strictEqual(formatElapsed(5400), '5.4 s');
  assert.strictEqual(formatElapsed(70.4), '70 ms');
});

// Compaction drops usage keys from rows in memory only. store.put() writes entry.rows,
// so the database must keep the full usage object, the only copy once a transcript is deleted.
const FAT_USAGE = { iterations: [{ n: 1 }], output_tokens_details: { thinking_tokens: 7 } };

// A real extract whose call rows also carry usage keys the aggregate never reads.
// Each refresh advances the clock past REFRESH_SHARE_MS, so none shares an earlier run.
function fatStore(dir, store) {
  const clock = { now: Date.now() };
  const rows = createRowStore({
    projectsDir: () => dir,
    store,
    now: () => clock.now,
    extract: async (file) => {
      const extracted = await extractFile(file);
      for (const call of extracted.calls) Object.assign(call.usage, FAT_USAGE);
      return extracted;
    },
  });
  return {
    entries: () => rows.entries(),
    refresh: async () => {
      clock.now += REFRESH_SHARE_MS + 1;
      await rows.refresh();
    },
  };
}

// The usage objects of every call in the database, read with a separate handle.
function storedUsages(dbFile) {
  const raw = new sqlite.DatabaseSync(dbFile);
  try {
    return raw.prepare('SELECT data FROM files').all().flatMap((r) => JSON.parse(r.data).calls.map((c) => c.usage));
  } finally {
    raw.close();
  }
}

const hasFatKeys = (usage) => 'iterations' in usage && 'output_tokens_details' in usage;

test('a file written to the database is compacted in memory after the write, and the database keeps the full usage', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const rows = fatStore(dir, store);

  await rows.refresh();

  const usage = rows.entries()[0].rows.calls[0].usage;
  assert.deepStrictEqual(usage, { input_tokens: 100, output_tokens: 50, output_tokens_details: { thinking_tokens: 7 } });
  const stored = storedUsages(dbFile);
  assert.strictEqual(stored.length, 1);
  assert.ok(hasFatKeys(stored[0]));
  store.close();
});

test('a file that is not written to the database keeps its full usage in memory', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'today', ['1'], 0);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const rows = fatStore(dir, store);

  await rows.refresh();

  assert.ok(hasFatKeys(rows.entries()[0].rows.calls[0].usage));
  assert.deepStrictEqual(storedUsages(dbFile), []);
  store.close();
});

test('a stored file whose transcript is deleted is written with its full usage, then compacted in memory', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'b', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const rows = fatStore(dir, store);
  await rows.refresh();
  const saved = fs.readFileSync(file);
  fs.unlinkSync(file);
  await rows.refresh();

  // The file reappears with a line from today, so its entry is newer than the database row.
  fs.writeFileSync(file, saved);
  fs.appendFileSync(file, usageLine('2', new Date().toISOString()) + '\n');
  await rows.refresh();
  assert.ok(rows.entries()[0].rows.calls.every((c) => hasFatKeys(c.usage)));
  fs.unlinkSync(file);
  await rows.refresh();

  const stored = storedUsages(dbFile);
  assert.strictEqual(stored.length, 2);
  assert.ok(stored.every(hasFatKeys));
  assert.ok(rows.entries()[0].rows.calls.every((c) => !('iterations' in c.usage)));
  store.close();
});

test('rows loaded from the database are compacted in memory and stay full in the database', async () => {
  const { dir } = makeProjects();
  writeFile(dir, 'old', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const seed = openStore(dbFile);
  await fatStore(dir, seed).refresh();
  seed.close();

  const store = openStore(dbFile);
  const rows = fatStore(dir, store);
  await rows.refresh();

  assert.deepStrictEqual(rows.entries()[0].rows.calls[0].usage, { input_tokens: 100, output_tokens: 50, output_tokens_details: { thinking_tokens: 7 } });
  assert.ok(storedUsages(dbFile).every(hasFatKeys));
  store.close();
});

test('a stored file that comes back unchanged after being deleted is written again with its full usage', async () => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 'back', ['1'], 2 * DAY_MS);
  const dbFile = tmpDb();
  const store = openStore(dbFile);
  const rows = fatStore(dir, store);
  await rows.refresh();
  const saved = fs.readFileSync(file);
  const { mtime } = fs.statSync(file);
  fs.unlinkSync(file);
  await rows.refresh();

  fs.writeFileSync(file, saved);
  fs.utimesSync(file, mtime, mtime);
  await rows.refresh();

  const stored = storedUsages(dbFile);
  assert.strictEqual(stored.length, 1);
  assert.ok(hasFatKeys(stored[0]));
  assert.strictEqual(rows.entries().length, 1);
  store.close();
});

test('step files are read as row sets with agentSteps, and read again when they change', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  const file = writeSteps(stepsDir, 'a1', [STEP], 60_000);
  const { rows, reads, refresh } = harness(dir, { agentUsageDir: stepsDir });
  await refresh();
  assert.deepStrictEqual(stepEntries(rows).map((e) => e.rows.agentSteps.length), [1]);
  const before = rows.generation;

  writeSteps(stepsDir, 'a1', [STEP, { ...STEP, index: 1, cacheRead: 40 }]);
  await refresh();
  assert.deepStrictEqual(stepEntries(rows).map((e) => e.rows.agentSteps.length), [2]);
  assert.ok(rows.generation > before);
  assert.strictEqual(reads.filter((r) => r === file).length, 2);
});

test('a step file that does not parse is read again at the next refresh', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  fs.mkdirSync(stepsDir, { recursive: true });
  const file = path.join(stepsDir, 'a1.json');
  fs.writeFileSync(file, '{"agentId":"a1","steps":[{"t":1');
  const { reads, refresh } = harness(dir, { agentUsageDir: stepsDir });
  await refresh();
  await refresh();
  assert.strictEqual(reads.filter((r) => r === file).length, 2);
});

test('a persisted step file not written for a day is deleted, and its rows stay', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  const file = writeSteps(stepsDir, 'a1', [STEP], 2 * DAY_MS);
  const store = openStore(tmpDb());
  const { rows, refresh } = harness(dir, { store, agentUsageDir: stepsDir });
  await refresh();
  assert.strictEqual(fs.existsSync(file), false);
  await refresh();
  assert.deepStrictEqual(stepEntries(rows).map((e) => e.rows.agentSteps.length), [1]);
  store.close();
});

test('a step file written within the day is kept', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  const file = writeSteps(stepsDir, 'a1', [STEP], 60 * 60 * 1000);
  const store = openStore(tmpDb());
  const { refresh } = harness(dir, { store, agentUsageDir: stepsDir });
  await refresh();
  assert.strictEqual(fs.existsSync(file), true);
  store.close();
});

test('with no store, an old step file is kept', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  const file = writeSteps(stepsDir, 'a1', [STEP], 2 * DAY_MS);
  const { refresh } = harness(dir, { agentUsageDir: stepsDir });
  await refresh();
  assert.strictEqual(fs.existsSync(file), true);
});

test('a step file rewritten without its earlier steps keeps them', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  writeSteps(stepsDir, 'a1', [STEP], 60_000);
  const { rows, refresh } = harness(dir, { agentUsageDir: stepsDir });
  await refresh();
  const later = { ...STEP, t: STEP.t + 1000, cacheRead: 40, output: 500 };
  writeSteps(stepsDir, 'a1', [later]);
  await refresh();
  const [entry] = stepEntries(rows);
  assert.deepStrictEqual(entry.rows.agentSteps.map((s) => s.cacheRead).sort((x, y) => x - y), [20, 40]);
  assert.strictEqual(entry.rows.minT, STEP.t);
  assert.strictEqual(entry.rows.maxT, later.t);
});

test('a pruned step file written again after a restart keeps the steps the database held', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  const file = writeSteps(stepsDir, 'a1', [STEP], 2 * DAY_MS);
  const dbPath = tmpDb();
  const store = openStore(dbPath);
  await harness(dir, { store, agentUsageDir: stepsDir }).refresh();
  assert.strictEqual(fs.existsSync(file), false);
  store.close();
  // The restarted server loads the stored rows. The continued agent's mod writes a
  // file with only its new step.
  const reopened = openStore(dbPath);
  const { rows, refresh } = harness(dir, { store: reopened, agentUsageDir: stepsDir });
  writeSteps(stepsDir, 'a1', [{ ...STEP, t: Date.now(), cacheRead: 40 }]);
  await refresh();
  assert.deepStrictEqual(stepEntries(rows).map((e) => e.rows.agentSteps.length), [2]);
  reopened.close();
});

test('a subagent response with no final line is priced at the output in its step file', async () => {
  const { base, dir } = makeProjects();
  const stepsDir = path.join(base, 'cc-dashboard', 'agent-usage');
  const ts = new Date().toISOString();
  const usage = { input_tokens: 2, output_tokens: 8, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
  const line = JSON.stringify({ type: 'assistant', timestamp: ts, sessionId: 's1', isSidechain: true, agentId: 'a1', requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-6', stop_reason: null, usage, content: [] } });
  fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), `${line}\n${line}\n`);
  writeSteps(stepsDir, 'a1', [{ ...STEP, input: 2, cacheWrite: 10, cacheRead: 20, output: 300 }]);
  const { rows, refresh } = harness(dir, { agentUsageDir: stepsDir });
  await refresh();
  const data = aggregate(rows.entries().map((e) => e.rows), { days: null });
  assert.strictEqual(data.summary.totalOutput, 300);
  assert.deepStrictEqual([data.meta.noFinalCalls, data.meta.noFinalCorrected], [1, 1]);
});

test('the row store passes its own intern map to store.loadAll', () => {
  const { dir } = makeProjects();
  let given = null;
  const store = { loadAll: (intern) => { given = intern; return []; }, put: () => {}, markGone: () => {}, transaction: (fn) => fn() };
  harness(dir, { store });
  assert.ok(given instanceof Map, 'loadAll received a map to intern through');
});

test('a transcript read again that lost calls logs one warning naming the file and the count', async (t) => {
  const { dir } = makeProjects();
  const file = writeFile(dir, 's1', ['a', 'b', 'c'], 60_000);
  const { refresh } = harness(dir);
  await refresh();
  const warn = t.mock.method(console, 'warn', () => {});
  writeFile(dir, 's1', ['a']);
  await refresh();
  await refresh(); // unchanged now, so not read again
  const lost = warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('stored calls'));
  assert.strictEqual(lost.length, 1);
  assert.ok(lost[0].includes(file));
  assert.ok(lost[0].includes('lost 2 of its 3 stored calls'));
});

test('a transcript that grows logs no lost-call warning', async (t) => {
  const { dir } = makeProjects();
  writeFile(dir, 's1', ['a'], 60_000);
  const { refresh } = harness(dir);
  await refresh();
  const warn = t.mock.method(console, 'warn', () => {});
  writeFile(dir, 's1', ['a', 'b']);
  await refresh();
  assert.strictEqual(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('stored calls')).length, 0);
});

test('a transcript read again while its last response streams logs no lost-call warning', async (t) => {
  const { dir } = makeProjects();
  const ts = new Date().toISOString();
  // One line of a response: the same message.id and requestId on every line, with
  // output_tokens growing and stop_reason set only on the last.
  const line = (id, output, stop) => JSON.stringify({
    timestamp: ts,
    requestId: `req-${id}`,
    message: { id: `msg-${id}`, model: 'claude-sonnet-4-6', stop_reason: stop, usage: { input_tokens: 100, output_tokens: output } },
  });
  const file = path.join(dir, 's1.jsonl');
  // The first read sees the stream-start line and half of the next line.
  fs.writeFileSync(file, [line('a', 50, 'end_turn'), line('b', 5, null)].join('\n') + '\n' + line('b', 300, 'end_turn').slice(0, 40));
  const { rows, refresh } = harness(dir);
  await refresh();
  const warn = t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(file, [line('a', 50, 'end_turn'), line('b', 5, null), line('b', 300, 'end_turn')].join('\n') + '\n');
  await refresh();
  assert.strictEqual(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('stored calls')).length, 0);
  const [entry] = rows.entries();
  assert.deepStrictEqual(entry.rows.calls.map((c) => [c.key, c.usage.output_tokens]), [['msg-a:req-a', 50], ['msg-b:req-b', 300]]);
});
