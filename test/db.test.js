'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('../lib/sqlite');
const { openDatabase, transaction, isBusy, SCHEMA_VERSION, SERVER_BUSY_TIMEOUT_MS } = require('../lib/db');
const { createRowStore } = require('../lib/rowstore');
const { openStore } = require('../lib/store');
const { createReviewDbGetter } = require('../lib/review-db');
const { tmpDir, freshServerDb, holdWriteLock } = helpers;

const tmpFile = () => path.join(helpers.tmpDir(null, 'db'), 'nested', 'transcripts.db');
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

test('SCHEMA_VERSION is 4', () => {
  assert.strictEqual(SCHEMA_VERSION, 4);
});

test('openDatabase creates the folder, all four tables, WAL mode and schema 4', () => {
  const file = tmpFile();
  const db = openDatabase(file);
  assert.deepStrictEqual(tables(db), ['files', 'meta', 'reviews', 'suggestions']);
  assert.strictEqual(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.strictEqual(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '4');
  db.close();
});

test('openDatabase upgrades a v1 file in place and keeps its rows', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const v1 = new DatabaseSync(file);
  v1.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER, mtime_ms REAL, version INTEGER, min_t INTEGER, max_t INTEGER, on_disk INTEGER, data TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema', '1');
    INSERT INTO files VALUES ('/p/a.jsonl', 1, 1.5, 1, 1, 2, 1, '{}');
  `);
  v1.close();
  const db = openDatabase(file);
  assert.deepStrictEqual(tables(db), ['files', 'meta', 'reviews', 'suggestions']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '4');
  const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(!indexNames.includes('reviews_reviewed_at'), 'the v3 index is gone');
  db.close();
});

test('openDatabase upgrades a v2 file to 4, keeps suggestions and dismissals, and then accepts duplicate', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const v2 = new DatabaseSync(file);
  v2.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema', '2');
    CREATE TABLE suggestions (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL CHECK (idx >= 0),
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      dismissed_at INTEGER,
      reason TEXT CHECK (reason IN ('done', 'not_useful')),
      CHECK ((dismissed_at IS NULL) = (reason IS NULL)),
      PRIMARY KEY (session_id, idx)
    );
    INSERT INTO suggestions VALUES ('a', 0, 'workflow', 'open one', NULL, NULL), ('a', 1, 'claude-md', 'done one', 5, 'done');
  `);
  v2.close();
  // A connection open before the rebuild, like the server's, still reads every row after it.
  const reader = new DatabaseSync(file);
  assert.strictEqual(reader.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n, 2);

  const db = openDatabase(file);
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '4');
  assert.deepStrictEqual(db.prepare('SELECT idx, text, dismissed_at, reason FROM suggestions ORDER BY idx').all().map((r) => ({ ...r })), [
    { idx: 0, text: 'open one', dismissed_at: null, reason: null },
    { idx: 1, text: 'done one', dismissed_at: 5, reason: 'done' },
  ]);
  assert.strictEqual(reader.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n, 2);
  reader.close();

  db.prepare("UPDATE suggestions SET dismissed_at = 6, reason = 'duplicate' WHERE session_id = 'a' AND idx = 0").run();
  const insert = db.prepare('INSERT INTO suggestions (session_id, idx, kind, text, dismissed_at, reason) VALUES (?, ?, ?, ?, ?, ?)');
  assert.throws(() => insert.run('a', 0, 'workflow', 't', null, null), 'primary key kept');
  assert.throws(() => insert.run('a', 2, 'workflow', 't', null, 'done'), 'half-dismissed row refused');
  assert.throws(() => insert.run('a', 2, 'workflow', 't', 5, 'bored'), 'unknown reason refused');
  db.close();

  const again = openDatabase(file);
  assert.deepStrictEqual(again.prepare('SELECT idx, reason FROM suggestions ORDER BY idx').all().map((r) => ({ ...r })), [
    { idx: 0, reason: 'duplicate' },
    { idx: 1, reason: 'done' },
  ]);
  again.close();
});

test('openDatabase upgrades a v3 file to 4, keeps rows and reasons, accepts expired and swaps the indexes', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const v3 = new DatabaseSync(file);
  v3.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema', '3');
    CREATE TABLE reviews (
      session_id TEXT PRIMARY KEY, project TEXT, ended_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
      claimed_at INTEGER, reviewed_at INTEGER, transcript TEXT, title TEXT, branch TEXT, skip_reason TEXT, error TEXT
    );
    CREATE INDEX reviews_reviewed_at ON reviews (reviewed_at);
    CREATE TABLE suggestions (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL CHECK (idx >= 0),
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      dismissed_at INTEGER,
      reason TEXT CHECK (reason IN ('done', 'not_useful', 'duplicate')),
      CHECK ((dismissed_at IS NULL) = (reason IS NULL)),
      PRIMARY KEY (session_id, idx)
    );
    INSERT INTO suggestions VALUES ('a', 0, 'workflow', 'open one', NULL, NULL), ('a', 1, 'claude-md', 'dup one', 5, 'duplicate');
  `);
  v3.close();

  const db = openDatabase(file);
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '4');
  assert.deepStrictEqual(db.prepare('SELECT idx, text, dismissed_at, reason FROM suggestions ORDER BY idx').all().map((r) => ({ ...r })), [
    { idx: 0, text: 'open one', dismissed_at: null, reason: null },
    { idx: 1, text: 'dup one', dismissed_at: 5, reason: 'duplicate' },
  ]);
  db.prepare("UPDATE suggestions SET dismissed_at = 6, reason = 'expired' WHERE session_id = 'a' AND idx = 0").run();
  const insert = db.prepare('INSERT INTO suggestions (session_id, idx, kind, text, dismissed_at, reason) VALUES (?, ?, ?, ?, ?, ?)');
  assert.throws(() => insert.run('a', 2, 'workflow', 't', 5, 'bored'), 'unknown reason refused');
  const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(indexNames.includes('suggestions_open'), indexNames.join(', '));
  assert.ok(indexNames.includes('reviews_reviewed_at_id'), indexNames.join(', '));
  assert.ok(!indexNames.includes('reviews_reviewed_at'), indexNames.join(', '));
  db.close();
});

test('openDatabase throws for a newer schema and leaves the bytes unchanged', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema', '5');");
  raw.close();
  const before = fs.readFileSync(file);
  assert.throws(() => openDatabase(file), /schema 5, newer than this dashboard's 4/);
  assert.ok(fs.readFileSync(file).equals(before));
});

test('openDatabase throws for a file that is not a database', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'this is not sqlite, '.repeat(50));
  assert.throws(() => openDatabase(file));
});

test('suggestions rejects a half-dismissed row and an unknown reason', () => {
  const db = openDatabase(tmpFile());
  const insert = db.prepare('INSERT INTO suggestions (session_id, idx, kind, text, dismissed_at, reason) VALUES (?, ?, ?, ?, ?, ?)');
  assert.throws(() => insert.run('a', 0, 'workflow', 't', 5, null));
  assert.throws(() => insert.run('a', 0, 'workflow', 't', null, 'done'));
  assert.throws(() => insert.run('a', 0, 'workflow', 't', 5, 'bored'));
  insert.run('a', 0, 'workflow', 't', null, null);
  insert.run('a', 1, 'workflow', 't', 5, 'done');
  insert.run('a', 2, 'workflow', 't', 5, 'duplicate');
  db.prepare("INSERT INTO suggestions (session_id, idx, kind, text, dismissed_at, reason) VALUES ('ok', 0, 'workflow', 't', 1, 'expired')").run();
  db.close();
});

test('transaction commits on return and rolls back on a throw', () => {
  const db = openDatabase(tmpFile());
  assert.strictEqual(transaction(db, () => db.prepare("INSERT INTO meta VALUES ('k', 'v')").run().changes), 1);
  assert.throws(() => transaction(db, () => {
    db.prepare("INSERT INTO meta VALUES ('k2', 'v')").run();
    throw new Error('boom');
  }), /boom/);
  assert.deepStrictEqual(db.prepare("SELECT key FROM meta WHERE key IN ('k', 'k2')").all().map((r) => r.key), ['k']);
  db.close();
});

test('transaction throws the original error when ROLLBACK also fails', () => {
  const db = openDatabase(tmpFile());
  // Closing the transaction inside fn makes the ROLLBACK in transaction() fail with "no transaction is active".
  assert.throws(() => transaction(db, () => {
    db.exec('ROLLBACK');
    throw new Error('original');
  }), /original/);
  db.close();
});

test('two connections write the same file without a busy error', () => {
  const file = tmpFile();
  const a = openDatabase(file);
  const b = openDatabase(file);
  a.prepare("INSERT INTO meta VALUES ('a', '1')").run();
  b.prepare("INSERT INTO meta VALUES ('b', '1')").run();
  assert.strictEqual(a.prepare("SELECT COUNT(*) AS n FROM meta WHERE key IN ('a','b')").get().n, 2);
  a.close();
  b.close();
});

test('openDatabase sets the busy timeout it is given', (t) => {
  const file = path.join(tmpDir(t, 'db'), 'transcripts.db');
  const db = openDatabase(file, { busyTimeoutMs: 250 });
  assert.strictEqual(db.prepare('PRAGMA busy_timeout').get().timeout, 250);
  db.close();
});

test('openDatabase refuses a busy timeout that is not a whole number, before it creates the file', (t) => {
  const file = path.join(tmpDir(t, 'db'), 'transcripts.db');
  assert.throws(() => openDatabase(file, { busyTimeoutMs: '250; DROP TABLE files' }), TypeError);
  assert.throws(() => openDatabase(file, { busyTimeoutMs: -1 }), TypeError);
  assert.throws(() => openDatabase(file, { busyTimeoutMs: 1e21 }), TypeError);
  assert.strictEqual(fs.existsSync(file), false);
});

test('createServerDb opens transcripts.db once, with a 250 ms busy timeout', (t) => {
  const { serverDb, file } = freshServerDb(t);
  const handle = serverDb.get();
  assert.strictEqual(serverDb.get(), handle);
  assert.strictEqual(SERVER_BUSY_TIMEOUT_MS, 250);
  assert.strictEqual(handle.prepare('PRAGMA busy_timeout').get().timeout, 250);
  assert.ok(fs.existsSync(file));
});

test('createServerDb does not keep a failed open, so the next call tries again', (t) => {
  const { serverDb, file } = freshServerDb(t);
  fs.mkdirSync(file, { recursive: true }); // SQLite cannot open a directory
  assert.throws(() => serverDb.get(), (err) => !isBusy(err));
  fs.rmdirSync(file);
  assert.ok(serverDb.get());
});

test('close closes the handle, removes the WAL file, and the next get opens a new handle', (t) => {
  const { serverDb, file } = freshServerDb(t);
  const first = serverDb.get();
  first.prepare("INSERT INTO meta (key, value) VALUES ('probe', '1')").run();
  assert.ok(fs.existsSync(`${file}-wal`));
  serverDb.close();
  assert.throws(() => first.prepare('SELECT 1'), /database is not open/);
  assert.strictEqual(fs.existsSync(`${file}-wal`), false, 'closing the last connection removes the WAL file');
  const second = serverDb.get();
  assert.notStrictEqual(second, first);
  serverDb.close();
  serverDb.close(); // a second close does nothing
});

test('a server write that meets another process\'s lock fails after about 250 ms, and isBusy says so', async (t) => {
  const { serverDb, file } = freshServerDb(t);
  const handle = serverDb.get();
  const release = await holdWriteLock(t, file);
  const started = Date.now();
  let err = null;
  try {
    handle.prepare("INSERT INTO meta (key, value) VALUES ('probe', '1')").run();
  } catch (e) {
    err = e;
  }
  const waited = Date.now() - started;
  await release();
  assert.ok(err, 'the write failed');
  assert.strictEqual(isBusy(err), true);
  assert.ok(waited >= 200 && waited < 1000, `waited ${waited} ms`);
});

test('isBusy is false for other errors and true for the extended busy codes', (t) => {
  const withCode = (errcode) => Object.assign(new Error('x'), { errcode });
  assert.strictEqual(isBusy(new Error('x')), false);
  assert.strictEqual(isBusy(undefined), false);
  assert.strictEqual(isBusy(withCode(1)), false);
  assert.strictEqual(isBusy(withCode(14)), false);
  assert.strictEqual(isBusy(withCode(5)), true);
  assert.strictEqual(isBusy(withCode(261)), true); // SQLITE_BUSY_RECOVERY
  assert.strictEqual(isBusy(withCode(517)), true); // SQLITE_BUSY_SNAPSHOT
});

test('a row-store write that meets the review lock gives up within 1000 ms, and the first refresh after the lock writes it', async (t) => {
  const { serverDb, base, file } = freshServerDb(t);
  const { REFRESH_SHARE_MS } = require('../lib/rowstore');
  const dir = path.join(base, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  // Three days old by content and by mtime, so the first refresh tries to store it.
  const when = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const transcript = path.join(dir, 'old.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    timestamp: new Date(when).toISOString(),
    requestId: 'req-1',
    message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
  }) + '\n');
  fs.utimesSync(transcript, when / 1000, when / 1000);
  const store = openStore(file, serverDb.get);
  const clock = { now: Date.now() };
  const rows = createRowStore({ projectsDir: () => path.join(base, 'projects'), store, now: () => clock.now });
  const stored = () => serverDb.get().prepare('SELECT COUNT(*) AS n FROM files').get().n;

  const release = await holdWriteLock(t, file);
  const warn = t.mock.method(console, 'warn', () => {});
  const started = Date.now();
  await rows.refresh();
  const took = Date.now() - started;
  assert.ok(took < 1000, `the refresh took ${took} ms`);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^\[store\] Could not write transcript rows \(database busy\), will retry on the next refresh: /);
  assert.strictEqual(stored(), 0);

  await release();
  clock.now += REFRESH_SHARE_MS + 1; // past the window in which a refresh is shared
  await rows.refresh();
  assert.strictEqual(stored(), 1);
});

test('a row store and a reviews getter built on one createServerDb share its handle', (t) => {
  const { serverDb, base, file } = freshServerDb(t);
  const spy = t.mock.method(serverDb, 'get');
  createRowStore({ projectsDir: () => path.join(base, 'projects'), store: openStore(file, () => serverDb.get()) });
  const getReviewDb = createReviewDbGetter(() => serverDb.get(), path.join(base, 'cc-dashboard', 'reviews'));
  const reviewDb = getReviewDb();
  assert.strictEqual(spy.mock.callCount(), 2);
  assert.strictEqual(spy.mock.calls[0].result, spy.mock.calls[1].result);
  assert.strictEqual(reviewDb, spy.mock.calls[0].result);
  assert.strictEqual(reviewDb, serverDb.get());
});
