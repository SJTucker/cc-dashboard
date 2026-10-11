'use strict';

// A pool worker that exits as soon as it gets a file, for test/extract-pool.test.js.
const { parentPort } = require('worker_threads');

parentPort.on('message', () => process.exit(3));
