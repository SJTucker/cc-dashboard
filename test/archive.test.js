'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir } = require('./helpers');
const { archiveTranscripts, withArchiveLock, getArchiveDir, STALE_LOCK_MS } = require('../lib/archive');

function setup(t) {
  const base = tmpDir(t, 'archive');
  const projectsDir = path.join(base, 'projects');
  const archiveDir = path.join(base, 'archive');
  fs.mkdirSync(path.join(projectsDir, 'demo'), { recursive: true });
  return { base, projectsDir, archiveDir, src: path.join(projectsDir, 'demo', 's.jsonl'), dest: path.join(archiveDir, 'demo', 's.jsonl.gz') };
}
const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString();
const run = (c, extra = {}) => archiveTranscripts({ projectsDir: c.projectsDir, archiveDir: c.archiveDir, ...extra });
const readState = (c) => JSON.parse(fs.readFileSync(path.join(c.archiveDir, 'state.json'), 'utf8'));

test('archives a new transcript as gzip that decompresses to the source', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  const r = run(c);
  assert.equal(r.added, 1);
  assert.equal(gunzip(c.dest), 'a\nb\n');
  assert.equal(readState(c).files['demo/s.jsonl'].bytes, 4);
});

test('appends new lines as a second gzip member', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.appendFileSync(c.src, 'c\n');
  const r = run(c);
  assert.equal(r.appended, 1);
  assert.equal(gunzip(c.dest), 'a\nb\nc\n');
});

test('a third run with no change leaves the gz untouched', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.appendFileSync(c.src, 'c\n');
  run(c);
  const before = fs.statSync(c.dest);
  const r = run(c);
  const after = fs.statSync(c.dest);
  assert.equal(r.unchanged, 1);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
});

test('archives only up to the last newline, then the rest later', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nhal');
  run(c);
  assert.equal(gunzip(c.dest), 'a\n');
  fs.appendFileSync(c.src, 'f\n');
  run(c);
  assert.equal(gunzip(c.dest), 'a\nhalf\n');
});

test('a source with no newline counts as unchanged and writes nothing', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'abc');
  const r = run(c);
  assert.equal(r.unchanged, 1);
  assert.equal(fs.existsSync(c.dest), false);
  assert.equal(readState(c).files['demo/s.jsonl'], undefined);
});

test('a gz truncated by a killed run is rebuilt whole', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.appendFileSync(c.src, 'c\n');
  const size = fs.statSync(c.dest).size;
  fs.truncateSync(c.dest, size - 5);
  const r = run(c);
  assert.equal(r.rebuilt, 1);
  assert.equal(gunzip(c.dest), 'a\nb\nc\n');
});

test('a gz appended to after the last state save is rebuilt whole', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  const stateFile = path.join(c.archiveDir, 'state.json');
  const saved = fs.readFileSync(stateFile);
  fs.appendFileSync(c.src, 'c\n');
  run(c);
  fs.writeFileSync(stateFile, saved);
  const r = run(c);
  assert.equal(r.rebuilt, 1);
  assert.equal(gunzip(c.dest), 'a\nb\nc\n');
});

test('a shorter source keeps the old archive aside and writes a fresh one', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.writeFileSync(c.src, 'x\n');
  const r = run(c, { now: () => Date.UTC(2026, 10, 17, 10, 15, 0) });
  assert.equal(r.rewritten, 1);
  assert.equal(gunzip(c.dest), 'x\n');
  assert.equal(gunzip(path.join(c.archiveDir, 'demo', 's.rewritten-20261117T101500Z.jsonl.gz')), 'a\nb\n');
});

test('a changed first line with a longer source counts as rewritten', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.writeFileSync(c.src, 'z\nb\nc\n');
  const r = run(c);
  assert.equal(r.rewritten, 1);
  assert.equal(gunzip(c.dest), 'z\nb\nc\n');
});

test('a changed archived tail with the same first bytes counts as rewritten', (t) => {
  const c = setup(t);
  const head = 'x'.repeat(5000) + '\n';
  fs.writeFileSync(c.src, head + 'a\n');
  run(c);
  fs.writeFileSync(c.src, head + 'b\nc\n');
  const r = run(c);
  assert.equal(r.rewritten, 1);
  assert.equal(gunzip(c.dest), head + 'b\nc\n');
});

test('copies a subagent meta.json next to its archived transcript', (t) => {
  const c = setup(t);
  const dir = path.join(c.projectsDir, 'demo', 's', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-x.jsonl'), 'a\n');
  const meta = path.join(dir, 'agent-x.meta.json');
  fs.writeFileSync(meta, '{"description":"Map tab"}');
  const copy = path.join(c.archiveDir, 'demo', 's', 'subagents', 'agent-x.meta.json');
  assert.equal(run(c).metaCopied, 1);
  assert.equal(fs.readFileSync(copy, 'utf8'), '{"description":"Map tab"}');
  assert.equal(run(c).metaCopied, 0);
  fs.writeFileSync(meta, '{"description":"Other"}');
  assert.equal(run(c).metaCopied, 1);
});

test('copies a meta.json that has no transcript beside it', (t) => {
  const c = setup(t);
  const dir = path.join(c.projectsDir, 'demo', 's', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-y.meta.json'), '{}');
  assert.equal(run(c).metaCopied, 1);
});

test('an unreadable transcript counts as failed and the others are archived', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const c = setup(t);
  const bad = path.join(c.projectsDir, 'demo', 'bad.jsonl');
  fs.writeFileSync(bad, 'a\n');
  fs.writeFileSync(c.src, 'b\n');
  fs.chmodSync(bad, 0o000);
  t.after(() => { try { fs.chmodSync(bad, 0o644); } catch { /* folder already removed */ } });
  const r = run(c);
  assert.equal(r.failed, 1);
  assert.equal(r.added, 1);
  assert.match(r.firstError, /EACCES/);
  assert.equal(readState(c).files['demo/bad.jsonl'], undefined);
});

test('a lost state.json rebuilds every archive from the source', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.unlinkSync(path.join(c.archiveDir, 'state.json'));
  const r = run(c);
  assert.equal(r.rebuilt, 1);
  assert.equal(gunzip(c.dest), 'a\nb\n');
});

test('getArchiveDir joins the config dir', () => {
  assert.equal(getArchiveDir('/x'), path.join('/x', 'cc-dashboard', 'archive'));
});

function lockSetup(t) {
  const base = tmpDir(t, 'archive-lock');
  const archiveDir = path.join(base, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  return { archiveDir, lock: path.join(archiveDir, '.lock'), takeover: path.join(archiveDir, '.lock.takeover') };
}

test('withArchiveLock runs fn and removes the lock', (t) => {
  const l = lockSetup(t);
  assert.deepEqual(withArchiveLock(l.archiveDir, () => 7), { ran: true, result: 7 });
  assert.equal(fs.existsSync(l.lock), false);
});

test('withArchiveLock skips while a fresh lock is held', (t) => {
  const l = lockSetup(t);
  const now = Date.now();
  fs.writeFileSync(l.lock, JSON.stringify({ pid: 1, startedAt: now - 60_000 }));
  let called = false;
  assert.deepEqual(withArchiveLock(l.archiveDir, () => { called = true; }, () => now), { ran: false });
  assert.equal(called, false);
  assert.equal(fs.existsSync(l.lock), true);
});

test('withArchiveLock takes over a stale lock', (t) => {
  const l = lockSetup(t);
  const now = Date.now();
  fs.writeFileSync(l.lock, JSON.stringify({ pid: 1, startedAt: now - STALE_LOCK_MS - 1 }));
  const r = withArchiveLock(l.archiveDir, () => 1, () => now);
  assert.equal(r.ran, true);
  assert.equal(fs.existsSync(l.lock), false);
  assert.equal(fs.existsSync(l.takeover), false);
});

test('an empty .lock younger than STALE_LOCK_MS counts as held', (t) => {
  const l = lockSetup(t);
  fs.writeFileSync(l.lock, '');
  assert.deepEqual(withArchiveLock(l.archiveDir, () => 1), { ran: false });
});

test('an empty .lock with an old mtime is taken over', (t) => {
  const l = lockSetup(t);
  fs.writeFileSync(l.lock, '');
  const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
  fs.utimesSync(l.lock, old, old);
  assert.equal(withArchiveLock(l.archiveDir, () => 1).ran, true);
});

test('a lock replaced by another run during fn is left in place', (t) => {
  const l = lockSetup(t);
  withArchiveLock(l.archiveDir, () => {
    fs.writeFileSync(l.lock, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
  });
  assert.equal(JSON.parse(fs.readFileSync(l.lock, 'utf8')).pid, 999999);
});

test('a held .lock.takeover returns ran false', (t) => {
  const l = lockSetup(t);
  const now = Date.now();
  fs.writeFileSync(l.lock, JSON.stringify({ pid: 1, startedAt: now - STALE_LOCK_MS - 1 }));
  fs.writeFileSync(l.takeover, '');
  let called = false;
  assert.deepEqual(withArchiveLock(l.archiveDir, () => { called = true; }, () => now), { ran: false });
  assert.equal(called, false);
});

test('withArchiveLock removes the lock when fn throws', (t) => {
  const l = lockSetup(t);
  assert.throws(() => withArchiveLock(l.archiveDir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(l.lock), false);
});

test('drops the state entry of a deleted source and keeps its archived gz', (t) => {
  const c = setup(t);
  fs.writeFileSync(c.src, 'a\nb\n');
  run(c);
  fs.rmSync(c.src);
  const r = run(c);
  assert.equal(r.failed, 0);
  assert.equal(readState(c).files['demo/s.jsonl'], undefined);
  assert.equal(gunzip(c.dest), 'a\nb\n');
});
