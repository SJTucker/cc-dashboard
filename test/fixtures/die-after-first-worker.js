'use strict';

// A pool worker that extracts its first file like lib/extract-worker.js and exits on
// the second. For test/extract-pool.test.js and test/rowstore.test.js.
const { parentPort } = require('worker_threads');
const { extractFile } = require('../../lib/extract');

let first = true;
parentPort.on('message', async ({ file }) => {
  if (!first) process.exit(3);
  first = false;
  parentPort.postMessage({ file, rows: await extractFile(file) });
});
