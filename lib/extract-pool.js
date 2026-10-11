'use strict';

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_FILE = path.join(__dirname, 'extract-worker.js');
const MAX_WORKERS = 8;

// One fewer than the cores, so the main thread keeps one to answer requests, and at
// most 8, because the files are read from one disk. At least 1.
function poolSize() {
  return Math.max(1, Math.min(os.availableParallelism() - 1, MAX_WORKERS));
}

// The rows of a file whose extract threw or whose worker stopped: empty, and ok:
// false like a failed read.
function failedRows() {
  return { ok: false, calls: [], toolUses: [], errors: [], edits: [], prompts: [], commands: [], sessions: Object.create(null), minT: null, maxT: null };
}

// Structured clone gives `sessions` the ordinary Object prototype. It is a null-prototype
// object so that a sessionId such as "constructor" or "__proto__" is an ordinary key
// (lib/extract.js), and Object.assign onto a null-prototype object keeps those keys as
// own properties.
function restorePrototype(rows) {
  rows.sessions = Object.assign(Object.create(null), rows.sessions);
  return rows;
}

/**
 * A fixed set of worker threads that each run extractFile. extract(file) resolves to
 * the file's rows. It rejects when extractFile threw in the worker, as a throw on
 * the main thread would. When a worker exits or emits an error, its file resolves to
 * failedRows(), the files still queued go to the workers that are left, and once no
 * worker is left every file resolves to failedRows(). `started` tells the caller
 * whether any worker ever answered. close() stops every worker.
 * A worker that cannot be created counts as stopped. `workerFile` and `createWorker`
 * are for the tests.
 */
function createExtractPool(size, { workerFile = WORKER_FILE, createWorker = (file) => new Worker(file) } = {}) {
  const queue = []; // { file, resolve, reject }
  const slots = [];
  let closed = false;
  // True once any worker has sent back an answer, a thrown extract included.
  let delivered = false;
  // Settles once it is known whether the threads can run at all: true at the first
  // answer from any worker, false when every worker has exited or failed with no
  // answer sent.
  let settleStarted;
  const started = new Promise((resolve) => { settleStarted = resolve; });

  function assign(slot) {
    if (slot.dead || slot.task || closed) return;
    const task = queue.shift();
    if (!task) return;
    slot.task = task;
    slot.worker.postMessage({ file: task.file });
  }

  function stop(slot, why) {
    if (slot.dead) return;
    slot.dead = true;
    const task = slot.task;
    slot.task = null;
    if (!closed) {
      const lost = task ? ` Its file ${task.file} counts as unreadable until the next refresh.` : '';
      console.warn(`[extract-pool] A worker stopped (${why}).${lost}`);
    }
    if (task) task.resolve(failedRows());
    if (slots.every((s) => s.dead) && !delivered) settleStarted(false);
    if (slots.every((s) => s.dead)) for (const waiting of queue.splice(0)) waiting.resolve(failedRows());
  }

  // Every slot exists before any worker is created, so a creation that throws on the
  // first slot does not look like the last worker stopping.
  for (let i = 0; i < size; i++) slots.push({ worker: null, task: null, dead: false });
  for (const slot of slots) {
    try {
      slot.worker = createWorker(workerFile);
    } catch (err) {
      stop(slot, err.message);
      continue;
    }
    slot.worker.on('message', (msg) => {
      delivered = true;
      settleStarted(true);
      const task = slot.task;
      if (!task) return;
      slot.task = null;
      if (msg.error !== undefined) task.reject(new Error(msg.error));
      else task.resolve(restorePrototype(msg.rows));
      assign(slot);
    });
    slot.worker.on('error', (err) => stop(slot, err.message));
    slot.worker.on('exit', (code) => stop(slot, `exit code ${code}`));
  }

  return {
    extract(file) {
      return new Promise((resolve, reject) => {
        if (closed || slots.every((s) => s.dead)) {
          resolve(failedRows());
          return;
        }
        queue.push({ file, resolve, reject });
        for (const slot of slots) assign(slot);
      });
    },
    async close() {
      closed = true;
      await Promise.all(slots.map((slot) => slot.worker && slot.worker.terminate()));
    },
    get closed() {
      return closed;
    },
    // Resolves to false when every worker exited or failed and none ever sent an
    // answer: the threads could not run, so the files the pool returned as failed
    // rows were never read, and the caller can read them itself. Resolves to true at
    // the first answer, after which a file that kills a worker must not be retried
    // elsewhere.
    started,
    // The number of workers still running.
    get live() {
      return slots.filter((slot) => !slot.dead).length;
    },
  };
}

// Runs fn(pool) and closes the pool afterwards, whether fn returns or throws, so a
// throw cannot leave threads running.
async function withPool(size, fn, options) {
  const pool = createExtractPool(size, options);
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

module.exports = { MAX_WORKERS, poolSize, failedRows, createExtractPool, withPool };
