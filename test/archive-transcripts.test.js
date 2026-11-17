'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'archive-transcripts');

function setup(t) {
  const cfg = tmpDir(t, 'archive-bin');
  fs.mkdirSync(path.join(cfg, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'projects', 'demo', 's.jsonl'), 'a\n');
  return cfg;
}

function run(cfg) {
  return spawnSync(process.execPath, [BIN], { input: '{}', encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
}

const archiveDir = (cfg) => path.join(cfg, 'cc-dashboard', 'archive');

test('archive-transcripts archives the config dir\'s transcripts', (t) => {
  const cfg = setup(t);
  const r = run(cfg);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^archive-transcripts: 1 added, 0 appended/);
  const gz = fs.readFileSync(path.join(archiveDir(cfg), 'demo', 's.jsonl.gz'));
  assert.strictEqual(zlib.gunzipSync(gz).toString(), 'a\n');
});

test('archive false writes nothing and exits 0', (t) => {
  const cfg = setup(t);
  fs.mkdirSync(path.join(cfg, 'cc-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'cc-dashboard', 'settings.json'), '{"archive": false}');
  const r = run(cfg);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.existsSync(archiveDir(cfg)), false);
});

test('a held lock exits 0 without archiving', (t) => {
  const cfg = setup(t);
  fs.mkdirSync(archiveDir(cfg), { recursive: true });
  fs.writeFileSync(path.join(archiveDir(cfg), '.lock'), JSON.stringify({ pid: 1, startedAt: Date.now() }));
  const r = run(cfg);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.existsSync(path.join(archiveDir(cfg), 'demo', 's.jsonl.gz')), false);
});

test('an unwritable archive folder exits 1 with the reason on stderr', (t) => {
  const cfg = setup(t);
  fs.mkdirSync(path.join(cfg, 'cc-dashboard'), { recursive: true });
  fs.writeFileSync(archiveDir(cfg), 'not a folder');
  const r = run(cfg);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.split('\n')[0].startsWith('archive-transcripts: '), r.stderr);
});

test('a transcript that cannot be read exits 1 after archiving the others', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root reads any file');
  const cfg = setup(t);
  const bad = path.join(cfg, 'projects', 'demo', 't.jsonl');
  fs.writeFileSync(bad, 'b\n');
  fs.chmodSync(bad, 0o000);
  const r = run(cfg);
  fs.chmodSync(bad, 0o644);
  assert.strictEqual(r.status, 1);
  assert.ok(fs.existsSync(path.join(archiveDir(cfg), 'demo', 's.jsonl.gz')));
  assert.ok(r.stderr.startsWith('archive-transcripts: 1 transcripts could not be archived: '), r.stderr);
});
