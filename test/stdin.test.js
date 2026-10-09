'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { readStdin } = require('../lib/stdin');

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
