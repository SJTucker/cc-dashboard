'use strict';

// A pool worker whose extract always throws, in the shape lib/extract-worker.js reports it.
const { parentPort } = require('worker_threads');

parentPort.on('message', ({ file }) => parentPort.postMessage({ file, error: `boom ${file}` }));
