'use strict';

// A pool worker that extracts like lib/extract-worker.js, except that it exits when
// the file's base name contains "die". For test/extract-pool.test.js.
const { parentPort } = require('worker_threads');
const path = require('path');
const { extractFile } = require('../../lib/extract');

parentPort.on('message', async ({ file }) => {
  if (path.basename(file).includes('die')) process.exit(3);
  parentPort.postMessage({ file, rows: await extractFile(file) });
});
