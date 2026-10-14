'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { writeFileAtomic, readJson, warnUnreadable, readable } = require('../lib/files');

test('writeFileAtomic writes the text and leaves only the target file', (t) => {
  const dir = helpers.tmpDir(t, 'files');
  const file = path.join(dir, 'a.json');
  writeFileAtomic(file, '{"x":1}');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"x":1}');
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
});

test('writeFileAtomic replaces an existing file', (t) => {
  const file = path.join(helpers.tmpDir(t, 'files'), 'a.json');
  fs.writeFileSync(file, 'old');
  writeFileAtomic(file, 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
});

test('a failed rename throws and leaves no tmp file', (t) => {
  const dir = helpers.tmpDir(t, 'files');
  const file = path.join(dir, 'a.json');
  fs.mkdirSync(file); // a directory in the target's place makes the rename fail
  assert.throws(() => writeFileAtomic(file, 'x'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
  assert.ok(!fs.existsSync(`${file}.${process.pid}`));
});

test('a failed write into a missing folder throws and creates nothing', (t) => {
  const dir = helpers.tmpDir(t, 'files');
  assert.throws(() => writeFileAtomic(path.join(dir, 'missing', 'a.json'), 'x'), { code: 'ENOENT' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('readJson returns the parsed value, or null for a missing or malformed file', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = helpers.tmpDir(t, 'files');
  fs.writeFileSync(path.join(dir, 'ok.json'), '{"a":[1]}');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"a":');
  assert.deepStrictEqual(readJson(path.join(dir, 'ok.json')), { a: [1] });
  assert.strictEqual(readJson(path.join(dir, 'bad.json')), null);
  assert.strictEqual(readJson(path.join(dir, 'none.json')), null);
});

test('readJson warns once per path for a file that does not parse, and never for a missing one', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = helpers.tmpDir(t, 'files');
  const bad = path.join(dir, 'warn-bad.json');
  fs.writeFileSync(bad, '{"a":');
  assert.strictEqual(readJson(path.join(dir, 'none.json')), null);
  assert.strictEqual(warn.mock.callCount(), 0);
  assert.strictEqual(readJson(bad), null);
  assert.strictEqual(readJson(bad), null);
  assert.strictEqual(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /warn-bad\.json/);
});

test('readJson warns again when a file breaks, recovers and breaks again', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const file = path.join(helpers.tmpDir(t, 'files'), 'flap.json');
  fs.writeFileSync(file, '{"a":');
  readJson(file);
  readJson(file);
  assert.strictEqual(warn.mock.callCount(), 1);
  fs.writeFileSync(file, '{"a":1}');
  assert.deepStrictEqual(readJson(file), { a: 1 });
  fs.writeFileSync(file, '{"a":');
  readJson(file);
  assert.strictEqual(warn.mock.callCount(), 2);
});

test('warnUnreadable words a SyntaxError as a parse problem and any other error as a read problem', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const warned = new Set();
  warnUnreadable(warned, '/x/a.json', new SyntaxError('Unexpected end of JSON input'));
  const parse = String(warn.mock.calls[0].arguments[0]);
  assert.match(parse, /could not be parsed and was skipped, possibly because it was being written: Unexpected end/);
  const denied = Object.assign(new Error("EACCES: permission denied, open '/x/b.json'"), { code: 'EACCES' });
  warnUnreadable(warned, '/x/b.json', denied);
  const read = String(warn.mock.calls[1].arguments[0]);
  assert.match(read, /\/x\/b\.json could not be read and was skipped/);
  assert.match(read, /EACCES/);
  assert.match(read, /permission denied/);
  assert.doesNotMatch(read, /parsed/);
  assert.strictEqual(read, "[files] /x/b.json could not be read and was skipped: EACCES: permission denied, open '/x/b.json'");
  const bare = Object.assign(new Error('disk gone'), { code: 'EIO' });
  warnUnreadable(warned, '/x/c.json', bare);
  assert.strictEqual(String(warn.mock.calls[2].arguments[0]), '[files] /x/c.json could not be read and was skipped: EIO disk gone');
});

test('warnUnreadable never warns for ENOENT', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  warnUnreadable(new Set(), '/x/none.json', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  assert.strictEqual(warn.mock.callCount(), 0);
});

test('readable re-arms a path in the warned Set', () => {
  const warned = new Set(['/x/a.json', '/x/b.json']);
  readable(warned, '/x/a.json');
  assert.deepStrictEqual([...warned], ['/x/b.json']);
});
