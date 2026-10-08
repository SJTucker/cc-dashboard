'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { openReviewDb, importReviewFiles, legacyReviewsDir, IMPORT_KEY } = require('../lib/review-db');

function fixture() {
  const base = helpers.tmpDir(null, 'review-db');
  const legacy = path.join(base, 'reviews');
  fs.mkdirSync(legacy);
  const write = (name, body) => fs.writeFileSync(path.join(legacy, name), typeof body === 'string' ? body : JSON.stringify(body));
  return { base, legacy, write, dbPath: path.join(base, 'transcripts.db') };
}

// node:sqlite rows have a null prototype, which deepStrictEqual rejects against plain objects.
const rows = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));

test('legacyReviewsDir is under the config dir', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/cfg';
  try {
    assert.strictEqual(legacyReviewsDir(), path.join('/cfg', 'cc-dashboard', 'reviews'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('openReviewDb imports every review file once, with all fields and suggestion order', () => {
  const f = fixture();
  f.write('done.json', {
    sessionId: 'done', project: 'demo', endedAt: 10, claimedAt: 11, reviewedAt: 12, status: 'done',
    transcript: '/t/done.jsonl', title: 'A title', branch: 'feat/x',
    suggestions: [{ kind: 'workflow', text: 'one' }, { kind: 'bogus', text: 'dropped' }, { kind: 'token-waste', text: 'two' }],
  });
  f.write('failed.json', { sessionId: 'failed', project: null, endedAt: 20, claimedAt: 21, reviewedAt: 22, status: 'failed', error: 'Haiku call failed' });
  f.write('skipped.json', { sessionId: 'skipped', project: 'demo', endedAt: 30, claimedAt: 31, reviewedAt: 32, status: 'skipped', reason: 'under 3 prompts' });
  f.write('pending.json', { sessionId: 'pending', project: 'demo', endedAt: 40, claimedAt: 41, status: 'pending' });
  const db = openReviewDb(f.dbPath, f.legacy);

  assert.deepStrictEqual(rows(db, 'SELECT * FROM reviews WHERE session_id = ?', 'done')[0], {
    session_id: 'done', project: 'demo', ended_at: 10, status: 'done', claimed_at: 11, reviewed_at: 12,
    transcript: '/t/done.jsonl', title: 'A title', branch: 'feat/x', skip_reason: null, error: null,
  });
  assert.deepStrictEqual(rows(db, 'SELECT idx, kind, text, dismissed_at, reason FROM suggestions WHERE session_id = ? ORDER BY idx', 'done'), [
    { idx: 0, kind: 'workflow', text: 'one', dismissed_at: null, reason: null },
    { idx: 1, kind: 'token-waste', text: 'two', dismissed_at: null, reason: null },
  ]);
  assert.strictEqual(rows(db, 'SELECT error FROM reviews WHERE session_id = ?', 'failed')[0].error, 'Haiku call failed');
  assert.strictEqual(rows(db, 'SELECT skip_reason FROM reviews WHERE session_id = ?', 'skipped')[0].skip_reason, 'under 3 prompts');
  assert.deepStrictEqual(rows(db, 'SELECT status, reviewed_at FROM reviews WHERE session_id = ?', 'pending')[0], { status: 'pending', reviewed_at: null });
  assert.ok(rows(db, 'SELECT value FROM meta WHERE key = ?', IMPORT_KEY)[0]);
  db.close();
});

test('the import skips a corrupt file, an unknown status, a bad session id and a non-json name, and still marks itself done', () => {
  const f = fixture();
  f.write('bad.json', '{not json');
  f.write('weird.json', { sessionId: 'weird', status: 'bogus' });
  f.write('..x.json', { sessionId: '../x', status: 'done', reviewedAt: 1 });
  f.write('notes.txt', 'hello');
  f.write('ok.json', { sessionId: 'ok', status: 'done', reviewedAt: 1, suggestions: [] });
  const db = openReviewDb(f.dbPath, f.legacy);
  assert.deepStrictEqual(rows(db, 'SELECT session_id FROM reviews').map((r) => r.session_id), ['ok']);
  db.close();
});

test('a session id missing from the file body is taken from the file name', () => {
  const f = fixture();
  f.write('named.json', { status: 'done', reviewedAt: 1, suggestions: [] });
  const db = openReviewDb(f.dbPath, f.legacy);
  assert.deepStrictEqual(rows(db, 'SELECT session_id FROM reviews').map((r) => r.session_id), ['named']);
  db.close();
});

test('a second open does not import again, and leaves the files untouched', () => {
  const f = fixture();
  f.write('a.json', { sessionId: 'a', status: 'done', reviewedAt: 1, suggestions: [] });
  openReviewDb(f.dbPath, f.legacy).close();
  f.write('late.json', { sessionId: 'late', status: 'done', reviewedAt: 1, suggestions: [] });
  fs.writeFileSync(path.join(f.legacy, 'a.json'), '{"changed":true}');
  const db = openReviewDb(f.dbPath, f.legacy);
  assert.deepStrictEqual(rows(db, 'SELECT session_id FROM reviews').map((r) => r.session_id), ['a']);
  assert.deepStrictEqual(fs.readdirSync(f.legacy).sort(), ['a.json', 'late.json']);
  db.close();
});

test('the import never overwrites a row that already exists', () => {
  const f = fixture();
  f.write('a.json', { sessionId: 'a', status: 'done', reviewedAt: 1, title: 'from file', suggestions: [] });
  const first = openReviewDb(f.dbPath, path.join(f.base, 'empty')); // marks the import done with no files
  first.prepare("DELETE FROM meta WHERE key = ?").run(IMPORT_KEY);
  first.prepare("INSERT INTO reviews (session_id, status, title) VALUES ('a', 'pending', 'in db')").run();
  first.close();
  const db = openReviewDb(f.dbPath, f.legacy);
  assert.deepStrictEqual(rows(db, 'SELECT status, title FROM reviews WHERE session_id = ?', 'a')[0], { status: 'pending', title: 'in db' });
  db.close();
});

test('a missing reviews folder still marks the import done', () => {
  const f = fixture();
  const db = openReviewDb(f.dbPath, path.join(f.base, 'nope'));
  assert.ok(rows(db, 'SELECT value FROM meta WHERE key = ?', IMPORT_KEY)[0]);
  assert.strictEqual(importReviewFiles(db, f.legacy), 0);
  db.close();
});

test('openReviewDb throws for a database it cannot open', () => {
  const f = fixture();
  fs.writeFileSync(f.dbPath, 'not a database '.repeat(100));
  assert.throws(() => openReviewDb(f.dbPath, f.legacy));
});

test('loading lib/review-db.js does not load the row store', () => {
  const { spawnSync } = require('child_process');
  const script = "require('./lib/review-db'); const loaded = Object.keys(require.cache).map((p) => require('path').basename(p)); process.stdout.write(JSON.stringify(loaded.filter((n) => ['rowstore.js', 'store.js'].includes(n))));";
  const res = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(res.stdout, '[]');
});
