'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, transaction, SCHEMA_VERSION } = require('../lib/db');
const { tmpDir, freshServerDb, holdWriteLock } = helpers;

const tmpFile = () => path.join(helpers.tmpDir(null, 'db'), 'nested', 'transcripts.db');
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

test('SCHEMA_VERSION is 2', () => {
  assert.strictEqual(SCHEMA_VERSION, 2);
});

test('openDatabase creates the folder, all four tables, WAL mode and schema 2', () => {
  const file = tmpFile();
  const db = openDatabase(file);
  assert.deepStrictEqual(tables(db), ['files', 'meta', 'reviews', 'suggestions']);
  assert.strictEqual(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.strictEqual(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '2');
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
  assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '2');
  db.close();
});

test('openDatabase throws for a newer schema and leaves the bytes unchanged', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema', '3');");
  raw.close();
  const before = fs.readFileSync(file);
  assert.throws(() => openDatabase(file), /schema 3, newer than this dashboard's 2/);
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
  assert.strictEqual(fs.existsSync(file), false);
});

test('getServerDb opens transcripts.db under CLAUDE_CONFIG_DIR once, with a 250 ms busy timeout', (t) => {
  const { dbModule, file } = freshServerDb(t);
  const handle = dbModule.getServerDb();
  assert.strictEqual(dbModule.getServerDb(), handle);
  assert.strictEqual(dbModule.SERVER_BUSY_TIMEOUT_MS, 250);
  assert.strictEqual(handle.prepare('PRAGMA busy_timeout').get().timeout, 250);
  assert.ok(fs.existsSync(file));
});

test('getServerDb does not cache a failed open, so the next call tries again', (t) => {
  const { dbModule, file } = freshServerDb(t);
  fs.mkdirSync(file, { recursive: true }); // SQLite cannot open a directory
  assert.throws(() => dbModule.getServerDb(), (err) => !dbModule.isBusy(err));
  fs.rmdirSync(file);
  assert.ok(dbModule.getServerDb());
});

test('closeServerDb closes the handle, removes the WAL file, and the next getServerDb opens a new handle', (t) => {
  const { dbModule, file } = freshServerDb(t);
  const first = dbModule.getServerDb();
  first.prepare("INSERT INTO meta (key, value) VALUES ('probe', '1')").run();
  assert.ok(fs.existsSync(`${file}-wal`));
  dbModule.closeServerDb();
  assert.throws(() => first.prepare('SELECT 1'), /database is not open/);
  assert.strictEqual(fs.existsSync(`${file}-wal`), false, 'closing the last connection removes the WAL file');
  const second = dbModule.getServerDb();
  assert.notStrictEqual(second, first);
  dbModule.closeServerDb();
  dbModule.closeServerDb(); // a second close does nothing
});

test('a server write that meets another process\'s lock fails after about 250 ms, and isBusy says so', async (t) => {
  const { dbModule, file } = freshServerDb(t);
  const handle = dbModule.getServerDb();
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
  assert.strictEqual(dbModule.isBusy(err), true);
  assert.ok(waited >= 200 && waited < 1000, `waited ${waited} ms`);
});

test('isBusy is false for other errors and true for the extended busy codes', (t) => {
  const { dbModule } = freshServerDb(t);
  const withCode = (errcode) => Object.assign(new Error('x'), { errcode });
  assert.strictEqual(dbModule.isBusy(new Error('x')), false);
  assert.strictEqual(dbModule.isBusy(undefined), false);
  assert.strictEqual(dbModule.isBusy(withCode(1)), false);
  assert.strictEqual(dbModule.isBusy(withCode(14)), false);
  assert.strictEqual(dbModule.isBusy(withCode(5)), true);
  assert.strictEqual(dbModule.isBusy(withCode(261)), true); // SQLITE_BUSY_RECOVERY
  assert.strictEqual(dbModule.isBusy(withCode(517)), true); // SQLITE_BUSY_SNAPSHOT
});
