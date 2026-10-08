'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore, upgradeRows, getStorePath, SCHEMA_VERSION } = require('../lib/store');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  // Node before 22.5: every test below that needs a database is skipped.
}
const skip = !sqlite && 'node:sqlite is not available';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-store-'));

const rowsOf = (extra = {}) => ({ ok: true, calls: [], toolUses: [], errors: [], edits: [], prompts: [], sessions: {}, minT: 100, maxT: 200, ...extra });
const entryOf = (extra = {}) => ({ size: 10, mtimeMs: 1234.5, version: 1, onDisk: true, rows: rowsOf(), ...extra });

test('getStorePath: TRANSCRIPTS_DB wins, then CLAUDE_CONFIG_DIR, then ~/.claude', (t) => {
  const saved = { db: process.env.TRANSCRIPTS_DB, dir: process.env.CLAUDE_CONFIG_DIR };
  t.after(() => {
    for (const [key, value] of [['TRANSCRIPTS_DB', saved.db], ['CLAUDE_CONFIG_DIR', saved.dir]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.TRANSCRIPTS_DB = '/x/y.db';
  process.env.CLAUDE_CONFIG_DIR = '/cfg';
  assert.strictEqual(getStorePath(), '/x/y.db');
  delete process.env.TRANSCRIPTS_DB;
  assert.strictEqual(getStorePath(), path.join('/cfg', 'cc-dashboard', 'transcripts.db'));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.strictEqual(getStorePath(), path.join(os.homedir(), '.claude', 'cc-dashboard', 'transcripts.db'));
});

test('openStore creates the file and its directory, and loadAll is empty', { skip }, () => {
  const file = path.join(tmpDir(), 'nested', 'transcripts.db');
  const store = openStore(file);
  assert.ok(store);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(store.loadAll(), []);
  store.close();
});

test('put then loadAll round-trips an entry, and put replaces the same path', { skip }, () => {
  const store = openStore(path.join(tmpDir(), 'a.db'));
  store.put('/p/one.jsonl', entryOf({ rows: rowsOf({ calls: [{ key: 'k' }] }) }));
  store.put('/p/one.jsonl', entryOf({ size: 20, rows: rowsOf({ calls: [{ key: 'k2' }] }) }));
  store.put('/p/two.jsonl', entryOf({ onDisk: false }));

  const loaded = store.loadAll().sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.strictEqual(loaded.length, 2);
  assert.deepStrictEqual(loaded[0], { path: '/p/one.jsonl', size: 20, mtimeMs: 1234.5, version: 1, minT: 100, maxT: 200, onDisk: true, rows: rowsOf({ calls: [{ key: 'k2' }] }) });
  assert.strictEqual(loaded[1].onDisk, false);
  store.close();
});

test('markGone clears onDisk and keeps the rows', { skip }, () => {
  const store = openStore(path.join(tmpDir(), 'a.db'));
  store.put('/p/one.jsonl', entryOf({ rows: rowsOf({ calls: [{ key: 'k' }] }) }));
  store.markGone('/p/one.jsonl');

  const [loaded] = store.loadAll();
  assert.strictEqual(loaded.onDisk, false);
  assert.deepStrictEqual(loaded.rows.calls, [{ key: 'k' }]);
  store.close();
});

test('a transaction that throws writes nothing', { skip }, () => {
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

test('the database persists across close and reopen', { skip }, () => {
  const file = path.join(tmpDir(), 'a.db');
  const first = openStore(file);
  first.put('/p/one.jsonl', entryOf());
  first.close();

  const second = openStore(file);
  assert.strictEqual(second.loadAll().length, 1);
  second.close();
});

test('loadAll skips a row whose data is not JSON, warns, and leaves it in the database', { skip }, (t) => {
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

test('openStore returns null with one warning when the path cannot be a database', { skip }, (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const blocker = path.join(tmpDir(), 'file');
  fs.writeFileSync(blocker, 'x');

  assert.strictEqual(openStore(path.join(blocker, 'a.db')), null);
  assert.strictEqual(warn.mock.callCount(), 1);
});

test('openStore returns null for a newer schema and leaves the file as it was', { skip }, (t) => {
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
