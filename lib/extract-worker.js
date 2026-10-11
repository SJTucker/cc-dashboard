'use strict';

// The body of one worker thread of lib/extract-pool.js. It answers each { file }
// message with { file, rows }, or with { file, error } when extractFile throws.
// extractFile returns a row set the structured clone can carry, except that the
// clone drops the null prototype of `sessions`. The pool puts it back.

const { parentPort } = require('worker_threads');
const { extractFile } = require('./extract');

parentPort.on('message', async ({ file }) => {
  try {
    parentPort.postMessage({ file, rows: await extractFile(file) });
  } catch (err) {
    parentPort.postMessage({ file, error: String((err && err.stack) || err) });
  }
});
