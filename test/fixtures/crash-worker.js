'use strict';

// A pool worker that throws outside any handler, so the thread emits 'error'.
const { parentPort } = require('worker_threads');

parentPort.on('message', () => {
  setImmediate(() => {
    throw new Error('worker crashed');
  });
});
