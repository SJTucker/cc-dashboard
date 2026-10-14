'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { openStore, upgradeRows, MIGRATIONS } = require('../lib/store');
const { getStorePath, SCHEMA_VERSION, openDatabase, isBusy } = require('../lib/db');
const sqlite = require('../lib/sqlite');

const tmpDir = () => helpers.tmpDir(null, 'store');

const rowsOf = (extra = {}) => ({ ok: true, calls: [], toolUses: [], errors: [], edits: [], prompts: [], sessions: {}, minT: 100, maxT: 200, ...extra });
const entryOf = (extra = {}) => ({ size: 10, mtimeMs: 1234.5, version: 1, onDisk: true, rows: rowsOf(), ...extra });

test('getStorePath is under the config dir', () => assert.strictEqual(getStorePath('/cfg'), path.join('/cfg', 'cc-dashboard', 'transcripts.db')));

test('openStore creates the file and its directory, and loadAll is empty', () => {
  const file = path.join(tmpDir(), 'nested', 'transcripts.db');
  const store = openStore(file);
  assert.ok(store);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(store.loadAll(), []);
  store.close();
});

test('put then loadAll round-trips an entry, and put replaces the same path', () => {
  const store = openStore(path.join(tmpDir(), 'a.db'));
  store.put('/p/one.jsonl', entryOf({ rows: rowsOf({ calls: [{ key: 'k' }] }) }));
  store.put('/p/one.jsonl', entryOf({ size: 20, rows: rowsOf({ calls: [{ key: 'k2' }] }) }));
  store.put('/p/two.jsonl', entryOf({ onDisk: false }));

  const loaded = store.loadAll().sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.strictEqual(loaded.length, 2);
  assert.deepStrictEqual(loaded[0], { path: '/p/one.jsonl', size: 20, mtimeMs: 1234.5, version: 1, minT: 100, maxT: 200, onDisk: true, rows: rowsOf({ calls: [{ key: 'k2' }], commands: [] }) });
  assert.strictEqual(loaded[1].onDisk, false);
  store.close();
});

test('loadAll drops usage keys the aggregate never reads, and leaves the stored data unchanged', () => {
  const file = path.join(tmpDir(), 'a.db');
  const store = openStore(file);
  const usage = { input_tokens: 1, output_tokens: 2, iterations: [{ n: 1 }], output_tokens_details: { thinking_tokens: 3 } };
  store.put('/p/one.jsonl', entryOf({ rows: rowsOf({ calls: [{ key: 'k', usage }] }) }));
  const before = JSON.stringify(rowsOf({ calls: [{ key: 'k', usage }] }));

  const [loaded] = store.loadAll();
  assert.deepStrictEqual(loaded.rows.calls[0].usage, { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 3 } });
  store.close();

  const raw = new sqlite.DatabaseSync(file);
  assert.strictEqual(raw.prepare('SELECT data FROM files').get().data, before);
  raw.close();
});

test('markGone clears onDisk and keeps the rows', () => {
  const store = openStore(path.join(tmpDir(), 'a.db'));
  store.put('/p/one.jsonl', entryOf({ rows: rowsOf({ calls: [{ key: 'k' }] }) }));
  store.markGone('/p/one.jsonl');

  const [loaded] = store.loadAll();
  assert.strictEqual(loaded.onDisk, false);
  assert.deepStrictEqual(loaded.rows.calls, [{ key: 'k' }]);
  store.close();
});

test('a transaction that throws writes nothing', () => {
  const store = openStore(path.join(tmpDir(), 'a.db'));
  assert.throws(() => store.transaction(() => {
    store.put('/p/one.jsonl', entryOf());
    throw new Error('stop');
  }), /stop/);
  assert.deepStrictEqual(store.loadAll(), []);

  store.transaction(() => store.put('/p/one.jsonl', entryOf()));
  assert.strictEqual(store.loadAll().length, 1);
  store.close();
});

test('the database persists across close and reopen', () => {
  const file = path.join(tmpDir(), 'a.db');
  const first = openStore(file);
  first.put('/p/one.jsonl', entryOf());
  first.close();

  const second = openStore(file);
  assert.strictEqual(second.loadAll().length, 1);
  second.close();
});

test('loadAll skips a row whose data is not JSON, warns, and leaves it in the database', (t) => {
  const file = path.join(tmpDir(), 'a.db');
  const store = openStore(file);
  store.put('/p/good.jsonl', entryOf());
  store.close();
  const raw = new sqlite.DatabaseSync(file);
  raw.prepare("INSERT INTO files (path, size, mtime_ms, version, min_t, max_t, on_disk, data) VALUES ('/p/bad.jsonl', 1, 1, 1, 1, 1, 1, '{broken')").run();
  raw.close();
  const warn = t.mock.method(console, 'warn', () => {});

  const reopened = openStore(file);
  assert.deepStrictEqual(reopened.loadAll().map((e) => e.path), ['/p/good.jsonl']);
  assert.match(warn.mock.calls[0].arguments[0], /bad\.jsonl/);
  reopened.close();

  const check = new sqlite.DatabaseSync(file);
  assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM files').get().n, 2);
  check.close();
});

test('openStore returns null with one warning when the path cannot be a database', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const blocker = path.join(tmpDir(), 'file');
  fs.writeFileSync(blocker, 'x');

  assert.strictEqual(openStore(path.join(blocker, 'a.db')), null);
  assert.strictEqual(warn.mock.callCount(), 1);
});

test('openStore returns null for a newer schema and leaves the file as it was', (t) => {
  const file = path.join(tmpDir(), 'a.db');
  openStore(file).close();
  const raw = new sqlite.DatabaseSync(file);
  raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(SCHEMA_VERSION + 1));
  raw.close();
  const before = fs.readFileSync(file);
  const warn = t.mock.method(console, 'warn', () => {});

  assert.strictEqual(openStore(file), null);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.ok(fs.readFileSync(file).equals(before), 'the database was not touched');
});

test('upgradeRows runs each migration in order up to EXTRACT_VERSION, and stops where the chain ends', () => {
  const { EXTRACT_VERSION } = require('../lib/extract');
  const migrations = { 0: (rows) => ({ ...rows, steps: [...(rows.steps || []), 'zero-to-one'] }) };

  const upgraded = upgradeRows({ ok: true }, 0, migrations);
  assert.strictEqual(upgraded.version, 1);
  assert.deepStrictEqual(upgraded.rows.steps, ['zero-to-one']);

  const current = upgradeRows({ ok: true }, EXTRACT_VERSION, migrations);
  assert.strictEqual(current.version, EXTRACT_VERSION);
  assert.deepStrictEqual(current.rows, { ok: true });

  const gap = upgradeRows({ ok: true }, 0, {});
  assert.strictEqual(gap.version, 0, 'with no migration the rows stay at their version');
});

test('migration 1 to 2 adds an empty commands list and keeps the other rows', () => {
  const old = rowsOf({ prompts: [{ id: 'p', t: 1, sessionId: 's' }] });
  const out = MIGRATIONS[1](old);
  assert.deepStrictEqual(out.commands, []);
  assert.deepStrictEqual(out.prompts, old.prompts);
  assert.ok(!('commands' in old), 'the input is not changed');
});

test('migration 2 to 3 gives each tool use the model of the call at or before its t', () => {
  const old = rowsOf({
    calls: [{ key: 'a', t: 10, model: 'm1' }, { key: 'b', t: 20, model: 'm2' }, { key: 'c', t: 20, model: 'm3' }],
    toolUses: [{ key: 'u1', t: 15, name: 'Bash', detail: 'x' }, { key: 'u2', t: 25, name: 'Read', detail: 'y' }, { key: 'u0', t: 5, name: 'Edit', detail: 'z' }],
  });
  const out = MIGRATIONS[2](old);
  assert.deepStrictEqual(out.toolUses.map((u) => [u.key, u.model]), [['u1', 'm1'], ['u2', 'm3'], ['u0', null]]);
  assert.ok(!('model' in old.toolUses[0]), 'the input is not changed');
});

test('migration 3 to 4 leaves a call without rebuild as it is', () => {
  const old = rowsOf({ calls: [{ key: 'a', t: 1, model: 'm', usage: {} }] });
  const out = MIGRATIONS[3](old);
  assert.deepStrictEqual(out.calls, old.calls);
  assert.ok(!('rebuild' in out.calls[0]), 'rebuild is written only on a call that rebuilt the cache');
});

test('migration 4 to 5 leaves a call without noFinal as it is', () => {
  const old = rowsOf({ calls: [{ key: 'a', t: 1, model: 'm', usage: {} }] });
  const out = MIGRATIONS[4](old);
  assert.deepStrictEqual(out.calls, old.calls);
  assert.ok(!('noFinal' in out.calls[0]), 'noFinal is written only where it is true');
});

test('upgradeRows takes a version 1 row set to EXTRACT_VERSION', () => {
  const { EXTRACT_VERSION } = require('../lib/extract');
  const old = rowsOf({ calls: [{ key: 'a', t: 10, model: 'm1' }], toolUses: [{ key: 'u', t: 11, name: 'Bash', detail: '' }] });
  const out = upgradeRows(old, 1);
  assert.strictEqual(out.version, EXTRACT_VERSION);
  assert.deepStrictEqual(out.rows.commands, []);
  assert.strictEqual(out.rows.toolUses[0].model, 'm1');
});

test('loadAll migrates the rows of every file, and an entry still on disk keeps its stored version', () => {
  const { EXTRACT_VERSION } = require('../lib/extract');
  const file = path.join(tmpDir(), 'a.db');
  const store = openStore(file);
  const old = rowsOf({ calls: [{ key: 'a', t: 10, model: 'm1' }], toolUses: [{ key: 'u', t: 11, name: 'Bash', detail: '' }] });
  store.put('/p/gone.jsonl', entryOf({ version: 1, onDisk: false, rows: old }));
  store.put('/p/here.jsonl', entryOf({ version: 1, onDisk: true, rows: old }));
  const byPath = Object.fromEntries(store.loadAll().map((e) => [e.path, e]));
  assert.strictEqual(byPath['/p/gone.jsonl'].version, EXTRACT_VERSION);
  assert.deepStrictEqual(byPath['/p/gone.jsonl'].rows.commands, []);
  assert.strictEqual(byPath['/p/here.jsonl'].version, 1, 'isCurrent still sees an old version and re-reads the file');
  assert.deepStrictEqual(byPath['/p/here.jsonl'].rows.commands, [], 'the shape is migrated in memory');
  assert.strictEqual(byPath['/p/here.jsonl'].rows.toolUses[0].model, 'm1');
  store.close();
  const raw = new sqlite.DatabaseSync(file);
  const stored = JSON.parse(raw.prepare('SELECT data FROM files WHERE path = ?').get('/p/gone.jsonl').data);
  raw.close();
  assert.ok(!('commands' in stored), 'the stored row is not rewritten');
});

test('loadAll interns strings in the map it is given', () => {
  const store = openStore(path.join(tmpDir(), 'a.db'));
  store.put('/p/a.jsonl', entryOf({ version: 5, rows: rowsOf({ calls: [{ key: 'a', t: 1, sessionId: 'sess-1', model: 'm', usage: {} }] }) }));
  const intern = new Map();
  store.loadAll(intern);
  assert.ok(intern.has('sess-1'), 'the caller map holds the interned session id');
  store.close();
});

const tableNames = (file) => {
  const raw = new sqlite.DatabaseSync(file);
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid").all().map((r) => r.name);
  raw.close();
  return names;
};

test('openStore on a newer schema creates no tables and leaves the bytes unchanged', (t) => {
  const file = path.join(tmpDir(), 'v2.db');
  const raw = new sqlite.DatabaseSync(file);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE files_v2 (path TEXT PRIMARY KEY, data TEXT); INSERT INTO meta VALUES ('schema', '${SCHEMA_VERSION + 1}');`);
  raw.close();
  const before = fs.readFileSync(file);
  t.mock.method(console, 'warn', () => {});

  assert.strictEqual(openStore(file), null);
  assert.deepStrictEqual(tableNames(file), ['meta', 'files_v2']);
  assert.ok(fs.readFileSync(file).equals(before));
});

test('a damaged data page: loadAll returns [] with one warning and the store never writes', (t) => {
  const file = path.join(tmpDir(), 'a.db');
  const store = openStore(file);
  store.transaction(() => {
    for (let i = 0; i < 200; i++) store.put(`/p/${i}`, entryOf({ rows: rowsOf({ calls: Array(50).fill({ k: 'x'.repeat(20) }) }) }));
  });
  store.close();
  const buf = fs.readFileSync(file);
  const pageSize = buf.readUInt16BE(16);
  const off = pageSize * Math.floor(buf.length / pageSize / 2);
  buf.fill(0xab, off, off + pageSize);
  fs.writeFileSync(file, buf);
  const before = fs.readFileSync(file);
  const warn = t.mock.method(console, 'warn', () => {});

  const damaged = openStore(file);
  assert.ok(damaged);
  assert.deepStrictEqual(damaged.loadAll(), []);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /a\.db/);
  damaged.put('/p/new.jsonl', entryOf());
  damaged.markGone('/p/1');
  let ran = false;
  damaged.transaction(() => { ran = true; damaged.put('/p/new2.jsonl', entryOf()); });
  assert.strictEqual(ran, true, 'transaction still runs fn');
  damaged.close();
  assert.ok(fs.readFileSync(file).equals(before), 'the damaged file was not written');
});

const insertRaw = (file, sql, ...params) => {
  const raw = new sqlite.DatabaseSync(file);
  raw.prepare(sql).run(...params);
  raw.close();
};
const INSERT = 'INSERT INTO files (path, size, mtime_ms, version, min_t, max_t, on_disk, data) VALUES (?, 1, 1, ?, 1, 1, 1, ?)';

for (const [label, version, data] of [
  ['SQL NULL data', 1, null],
  ['the text null', 1, 'null'],
  ['a JSON number', 1, '5'],
  ['a JSON array', 1, '[]'],
  ['a version newer than EXTRACT_VERSION', 999, '{"ok":true}'],
]) {
  test(`loadAll skips a row with ${label}, warns, and keeps it in the database`, (t) => {
    const file = path.join(tmpDir(), 'a.db');
    const store = openStore(file);
    store.put('/p/good.jsonl', entryOf());
    store.close();
    insertRaw(file, INSERT, '/p/odd.jsonl', version, data);
    const warn = t.mock.method(console, 'warn', () => {});

    const reopened = openStore(file);
    assert.deepStrictEqual(reopened.loadAll().map((e) => e.path), ['/p/good.jsonl']);
    assert.match(warn.mock.calls[0].arguments[0], /odd\.jsonl/);
    reopened.close();
    const check = new sqlite.DatabaseSync(file);
    assert.strictEqual(check.prepare('SELECT COUNT(*) AS n FROM files').get().n, 2);
    check.close();
  });
}

test('loadAll skips a row whose migration throws and warns', (t) => {
  const { MIGRATIONS } = require('../lib/store');
  const file = path.join(tmpDir(), 'a.db');
  const store = openStore(file);
  store.close();
  insertRaw(file, INSERT.replace('1, 1, 1, ?)', '1, 1, 0, ?)'), '/p/old.jsonl', 0, '{"ok":true}');
  MIGRATIONS[0] = () => { throw new Error('bad migration'); };
  t.after(() => { delete MIGRATIONS[0]; });
  const warn = t.mock.method(console, 'warn', () => {});

  const reopened = openStore(file);
  assert.deepStrictEqual(reopened.loadAll(), []);
  assert.match(warn.mock.calls[0].arguments[0], /old\.jsonl.*bad migration/);
  reopened.close();
});

test('lib/store.js exports only MIGRATIONS, upgradeRows and openStore', () => {
  assert.deepStrictEqual(Object.keys(require('../lib/store')).sort(), ['MIGRATIONS', 'openStore', 'upgradeRows']);
});

test('store.transaction takes the write lock before fn runs', async (t) => {
  const file = path.join(tmpDir(t, 'store'), 'transcripts.db');
  openDatabase(file).close();
  const store = openStore(file, () => openDatabase(file, { busyTimeoutMs: 50 }));
  t.after(() => store.close());
  const release = await helpers.holdWriteLock(t, file);
  let ran = false;
  assert.throws(() => store.transaction(() => { ran = true; }), (err) => isBusy(err));
  await release();
  assert.strictEqual(ran, false, 'BEGIN IMMEDIATE failed before fn ran');
  store.transaction(() => { ran = true; });
  assert.strictEqual(ran, true);
});

test('openStore with a getDb that throws returns null with one warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.strictEqual(openStore('/nowhere/transcripts.db', () => { throw new Error('database is locked'); }), null);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^\[store\] Could not open \/nowhere\/transcripts\.db, so usage history will not be kept: database is locked$/);
});

test('openStore leaves open a handle that getDb gave it, even when the store cannot be built', (t) => {
  const file = path.join(tmpDir(t, 'store'), 'bare.db');
  const handle = new sqlite.DatabaseSync(file); // no tables, so makeStore's first prepare throws
  t.after(() => handle.close());
  t.mock.method(console, 'warn', () => {});
  assert.strictEqual(openStore(file, () => handle), null);
  assert.deepStrictEqual({ ...handle.prepare('SELECT 1 AS x').get() }, { x: 1 });
});

test('store.close leaves a handle that getDb gave the store usable', (t) => {
  const file = path.join(tmpDir(t, 'store'), 'transcripts.db');
  const handle = openDatabase(file);
  t.after(() => handle.close());
  const store = openStore(file, () => handle);
  store.close();
  assert.deepStrictEqual({ ...handle.prepare('SELECT 1 AS x').get() }, { x: 1 });
});
