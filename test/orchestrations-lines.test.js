'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { createLinesCache } = require('../lib/orchestrations/lines-cache');
const { parseBoard } = require('../lib/orchestrations/board');

function setup(t, opts) {
  const dir = tmpDir(t, 'lines');
  return { dir, file: path.join(dir, 'f.jsonl'), cache: createLinesCache(opts) };
}

test('read returns only complete lines and picks up the tail later', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'a\nb\npart');
  assert.deepEqual(cache.read(file).lines, ['a', 'b']);
  fs.appendFileSync(file, 'ial\nc\n');
  assert.deepEqual(cache.read(file).lines, ['a', 'b', 'partial', 'c']);
});

test('read does not re-read bytes it already has', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'one\ntwo\n');
  cache.read(file);
  fs.appendFileSync(file, 'three\n');
  const lengths = [];
  const orig = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buf, off, len, pos) => {
    lengths.push([len, pos]);
    return orig(fd, buf, off, len, pos);
  });
  assert.deepEqual(cache.read(file).lines, ['one', 'two', 'three']);
  assert.deepEqual(lengths, [[6, 8]]);
});

test('read keeps a multi-byte character split across reads intact', (t) => {
  const { file, cache } = setup(t);
  const bytes = Buffer.from('é\n');
  fs.writeFileSync(file, bytes.subarray(0, 1));
  assert.deepEqual(cache.read(file).lines, []);
  fs.appendFileSync(file, bytes.subarray(1));
  assert.deepEqual(cache.read(file).lines, ['é']);
});

test('read starts over when the file shrinks', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'a\nb\nc\n');
  assert.equal(cache.read(file).lines.length, 3);
  fs.writeFileSync(file, 'x\n');
  assert.deepEqual(cache.read(file).lines, ['x']);
});

test('read drops the entry and returns null when the file vanishes before it is opened', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'a\n');
  cache.read(file);
  fs.appendFileSync(file, 'b\n');
  t.mock.method(fs, 'openSync', () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  });
  assert.equal(cache.read(file), null);
  assert.equal(cache.size(), 0);
});

test('read starts over when the file is replaced by one of the same size', (t) => {
  const { dir, file, cache } = setup(t);
  fs.writeFileSync(file, 'a\nb\n');
  assert.deepEqual(cache.read(file).lines, ['a', 'b']);
  const other = path.join(dir, 'other');
  fs.writeFileSync(other, 'x\ny\n');
  fs.renameSync(other, file);
  assert.deepEqual(cache.read(file).lines, ['x', 'y']);
});

test('read starts over when a file that did not grow has a new mtime', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'a\nb\n');
  const first = cache.read(file);
  fs.writeFileSync(file, 'x\ny\n');
  const later = new Date(first.mtimeMs + 60000);
  fs.utimesSync(file, later, later);
  assert.deepEqual(cache.read(file).lines, ['x', 'y']);
});

test('read keeps one array while the file grows and raises version on each change', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'a\n');
  const first = cache.read(file);
  assert.equal(cache.read(file).version, first.version, 'no change, same version');
  fs.appendFileSync(file, 'b\n');
  const second = cache.read(file);
  assert.equal(second.lines, first.lines);
  assert.ok(second.version > first.version);
  fs.appendFileSync(file, 'partial');
  assert.equal(cache.read(file).version, second.version, 'an unterminated tail adds no lines');
  fs.writeFileSync(file, 'x\n');
  const reset = cache.read(file);
  assert.notEqual(reset.lines, first.lines);
  assert.ok(reset.version > second.version);
});

test('version does not repeat after an entry is dropped and read again', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'a\n');
  const before = cache.read(file).version;
  fs.rmSync(file);
  assert.equal(cache.read(file), null);
  fs.writeFileSync(file, 'a\n');
  assert.ok(cache.read(file).version > before);
});

test('read returns null for a missing file', (t) => {
  const { dir, cache } = setup(t);
  assert.equal(cache.read(path.join(dir, 'nope')), null);
});

test('read reports size and mtimeMs', (t) => {
  const { file, cache } = setup(t);
  fs.writeFileSync(file, 'ab\n');
  const r = cache.read(file);
  assert.equal(r.size, 3);
  assert.equal(r.mtimeMs, fs.statSync(file).mtimeMs);
});

test('prune drops entries idle for 30 minutes', (t) => {
  let clock = 1000;
  const { file, cache } = setup(t, { now: () => clock });
  fs.writeFileSync(file, 'a\n');
  cache.read(file);
  clock += 30 * 60 * 1000 - 1;
  cache.prune();
  const reads = [];
  const orig = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buf, off, len, pos) => {
    reads.push(pos);
    return orig(fd, buf, off, len, pos);
  });
  cache.read(file);
  assert.deepEqual(reads, [], 'entry kept just under the limit, nothing re-read');
  clock += 30 * 60 * 1000;
  cache.prune();
  cache.read(file);
  assert.deepEqual(reads, [0], 'entry dropped, re-read from offset 0');
});

test('parseBoard skips bad lines and orders newest first', () => {
  const lines = [
    JSON.stringify({ t: '2026-11-10T10:00:00Z', from: 'Task 1', title: 'a', body: 'x' }),
    '{not json',
    JSON.stringify({ t: '2026-11-10T11:00:00Z', from: 'Task 2', title: 'b' }),
    JSON.stringify([1]),
    JSON.stringify({ t: 'x', from: 'Task 3' }),
  ];
  assert.deepEqual(parseBoard(lines).map((p) => p.title), ['b', 'a']);
  assert.equal(parseBoard(lines)[0].body, '');
});
