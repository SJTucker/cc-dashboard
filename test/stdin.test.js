'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readStdin, readInput } = require('../lib/stdin');

test('readStdin joins every chunk as UTF-8, including a character split across chunks', async () => {
  const stream = new PassThrough();
  const text = readStdin(stream);
  const bytes = Buffer.from('{"a":"é"}');
  stream.write(bytes.subarray(0, 8)); // ends inside the two bytes of é
  stream.end(bytes.subarray(8));
  assert.strictEqual(await text, '{"a":"é"}');
});

test('readStdin rejects when the stream fails', async () => {
  const stream = new PassThrough();
  const text = readStdin(stream);
  stream.destroy(new Error('broken pipe'));
  await assert.rejects(text, /broken pipe/);
});

test('readInput reads the --input file and deletes it', async () => {
  const file = path.join(os.tmpdir(), `stdin-test-${process.pid}-a.txt`);
  fs.writeFileSync(file, 'text with é');
  assert.strictEqual(await readInput(['--current', '1', '--input', file]), 'text with é');
  assert.strictEqual(fs.existsSync(file), false);
});

test('readInput reads the stream when --input is absent', async () => {
  const stream = new PassThrough();
  const text = readInput(['--current', '1'], stream);
  stream.end('from stdin');
  assert.strictEqual(await text, 'from stdin');
});

test('readInput rejects when the --input file is missing', async () => {
  await assert.rejects(readInput(['--input', path.join(os.tmpdir(), 'stdin-test-missing.txt')]), /ENOENT/);
});
