'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, transaction, SCHEMA_VERSION } = require('../lib/db');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-db-')), 'nested', 'transcripts.db');
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
