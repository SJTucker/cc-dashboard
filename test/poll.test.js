'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createPoller } = require('../public/poll');

// Timers the test fires by hand. fire() runs the oldest pending callback and
// returns its promise, so a test can act while a run is still in progress.
function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire() {
      const [id, { fn }] = pending.entries().next().value;
      pending.delete(id);
      return fn();
    },
  };
}

// A run that stays in progress until the test calls release().
function heldRun() {
  const run = () => new Promise((resolve) => { run.release = resolve; });
  return run;
}

test('createPoller waits ms before the first run and schedules the next after it', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const poller = createPoller(async () => { runs++; }, 5000, timers);
  poller.start();
  assert.deepStrictEqual([...timers.pending.values()].map((t) => t.ms), [5000]);
  await timers.fire();
  assert.strictEqual(runs, 1);
  assert.strictEqual(timers.pending.size, 1);
  assert.strictEqual(poller.running, true);
});

test('createPoller sets no timer while a run is in progress, so a slow run is never overlapped', async () => {
  const timers = fakeTimers();
  const run = heldRun();
  createPoller(run, 5000, timers).start();
  const firing = timers.fire();
  assert.strictEqual(timers.pending.size, 0);
  run.release();
  await firing;
  assert.strictEqual(timers.pending.size, 1);
});

test('createPoller stop during a run leaves no timer after the run finishes', async () => {
  const timers = fakeTimers();
  const run = heldRun();
  const poller = createPoller(run, 5000, timers);
  poller.start();
  const firing = timers.fire();
  poller.stop();
  run.release();
  await firing;
  assert.strictEqual(timers.pending.size, 0);
  assert.strictEqual(poller.running, false);
});

test('createPoller start during a run leaves one chain, not two', async () => {
  const timers = fakeTimers();
  const run = heldRun();
  const poller = createPoller(run, 5000, timers);
  poller.start();
  const firing = timers.fire();
  poller.start();
  run.release();
  await firing;
  assert.strictEqual(timers.pending.size, 1);
});

test('createPoller stop before the first run cancels it', () => {
  const timers = fakeTimers();
  const poller = createPoller(async () => {}, 5000, timers);
  poller.start();
  poller.stop();
  assert.strictEqual(timers.pending.size, 0);
  assert.strictEqual(poller.running, false);
});
