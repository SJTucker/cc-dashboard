'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { writeFileAtomic, readJson } = require('../lib/files');

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
  const dir = helpers.tmpDir(t, 'files');
  fs.writeFileSync(path.join(dir, 'ok.json'), '{"a":[1]}');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"a":');
  assert.deepStrictEqual(readJson(path.join(dir, 'ok.json')), { a: [1] });
  assert.strictEqual(readJson(path.join(dir, 'bad.json')), null);
  assert.strictEqual(readJson(path.join(dir, 'none.json')), null);
});
