'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const helpers = require('./helpers');
const {
  createUsageRefresher, getUsageRefreshDir, ARGS, INTERVAL_MS, FRESH_MS, TIMEOUT_MS, KILL_GRACE_MS,
} = require('../lib/usage-refresh');

const MINUTE = 60 * 1000;

// A refresher with a fake spawn, clock, cache time, timers and log. Each spawned
// process is an EventEmitter. kill() emits exit with SIGTERM at once.
function harness({ cacheAt = null } = {}) {
  let t = Date.parse('2026-10-14T18:00:00Z');
  let cache = cacheAt;
  const calls = [];
  const timers = [];
  const logs = [];
  const cwd = getUsageRefreshDir(helpers.tmpDir(null, 'usage-refresh'));
  const spawn = (bin, args, opts) => {
    const proc = new EventEmitter();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit('exit', null, 'SIGTERM');
      return true;
    };
    calls.push({ bin, args, opts, proc });
    return proc;
  };
  const refresher = createUsageRefresher({
    bin: 'claude',
    cwd,
    spawn,
    lastFetchedAt: () => cache,
    now: () => t,
    log: (line) => logs.push(line),
    setTimer: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => { if (h) h.cleared = true; },
  });
  return {
    refresher, calls, timers, logs, cwd,
    advance: (ms) => { t += ms; },
    setCache: (v) => { cache = v; },
    now: () => t,
    last: () => calls[calls.length - 1].proc,
  };
}

test('getUsageRefreshDir is a folder under cc-dashboard', () => {
  assert.strictEqual(getUsageRefreshDir('/cfg'), path.join('/cfg', 'cc-dashboard', 'usage-refresh'));
});

test('seen runs claude -p --no-session-persistence /usage in the refresh folder', () => {
  const h = harness();
  assert.strictEqual(h.refresher.seen(), true);
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].bin, 'claude');
  assert.deepStrictEqual(h.calls[0].args, ['-p', '--no-session-persistence', '/usage']);
  assert.deepStrictEqual(ARGS, ['-p', '--no-session-persistence', '/usage']);
  assert.strictEqual(h.calls[0].opts.cwd, h.cwd);
  assert.strictEqual(h.calls[0].opts.stdio, 'ignore');
  assert.ok(fs.statSync(h.cwd).isDirectory());
  assert.strictEqual(h.refresher.running(), true);
});

test('seen starts no second run while one is running, from any number of polls', () => {
  const h = harness();
  h.refresher.seen();
  h.advance(INTERVAL_MS + MINUTE);
  for (let i = 0; i < 5; i += 1) assert.strictEqual(h.refresher.seen(), false);
  assert.strictEqual(h.calls.length, 1);
});

test('seen runs at most once per 5 minutes while the page polls', () => {
  const h = harness();
  h.refresher.seen();
  h.last().emit('exit', 0, null);
  h.advance(INTERVAL_MS - 1);
  assert.strictEqual(h.refresher.seen(), false);
  h.advance(1);
  assert.strictEqual(h.refresher.seen(), true);
  assert.strictEqual(h.calls.length, 2);
});

test('seen waits until the cache is 5 minutes old, so a typed /usage resets the wait', () => {
  const h = harness();
  h.setCache(h.now() - 2 * MINUTE);
  assert.strictEqual(h.refresher.seen(), false);
  h.advance(3 * MINUTE - 1);
  assert.strictEqual(h.refresher.seen(), false);
  h.advance(1);
  assert.strictEqual(h.refresher.seen(), true);
});

test('refreshNow runs when the cache is a minute old, and not when it is newer', () => {
  const h = harness();
  h.setCache(h.now() - (FRESH_MS - 1));
  assert.strictEqual(h.refresher.refreshNow(), false);
  h.advance(1);
  assert.strictEqual(h.refresher.refreshNow(), true);
});

test('refreshNow ignores the 5-minute wait that seen keeps', () => {
  const h = harness();
  h.refresher.seen();
  h.last().emit('exit', 0, null);
  h.advance(MINUTE);
  assert.strictEqual(h.refresher.seen(), false);
  assert.strictEqual(h.refresher.refreshNow(), true);
});

test('a run is stopped after 90 seconds, logged once, and allowed again 5 minutes later', () => {
  const h = harness();
  h.refresher.seen();
  assert.strictEqual(h.timers[0].ms, TIMEOUT_MS);
  h.timers[0].fn();
  assert.strictEqual(h.calls[0].proc.killed, true);
  assert.strictEqual(h.refresher.running(), false);
  assert.strictEqual(h.logs.length, 1);
  assert.match(h.logs[0], /took over 90 s/);

  h.advance(INTERVAL_MS);
  assert.strictEqual(h.refresher.seen(), true);
  h.timers[1].fn();
  assert.strictEqual(h.logs.length, 1);
});

test('a missing claude binary is logged once with the variable to set', () => {
  const h = harness();
  h.refresher.seen();
  h.last().emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.strictEqual(h.refresher.running(), false);
  assert.strictEqual(h.timers[0].cleared, true);
  assert.match(h.logs[0], /CC_DASHBOARD_CLAUDE_BIN/);
  h.advance(INTERVAL_MS);
  h.refresher.seen();
  h.last().emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.strictEqual(h.logs.length, 1);
});

test('an error followed by an exit for the same run logs one line', () => {
  const h = harness();
  h.refresher.seen();
  h.last().emit('error', Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' }));
  h.last().emit('exit', 1, null);
  assert.strictEqual(h.logs.length, 1);
});

test('a success clears the failure log, so a later failure is logged again', () => {
  const h = harness();
  h.refresher.seen();
  h.last().emit('exit', 1, null);
  h.advance(INTERVAL_MS);
  h.refresher.seen();
  h.last().emit('exit', 0, null);
  h.advance(INTERVAL_MS);
  h.refresher.seen();
  h.last().emit('exit', 1, null);
  assert.strictEqual(h.logs.length, 2);
  assert.match(h.logs[1], /exited with 1/);
});

test('a spawn that throws is logged and leaves nothing running', () => {
  const logs = [];
  const refresher = createUsageRefresher({
    bin: 'claude',
    cwd: getUsageRefreshDir(helpers.tmpDir(null, 'usage-refresh')),
    lastFetchedAt: () => null,
    spawn: () => { throw new Error('bad argument'); },
    log: (line) => logs.push(line),
  });
  assert.strictEqual(refresher.seen(), false);
  assert.strictEqual(refresher.running(), false);
  assert.match(logs[0], /could not start claude: bad argument/);
});

test('stop kills a running child without a log line, and nothing starts after it', () => {
  const h = harness();
  h.refresher.seen();
  h.refresher.stop();
  assert.strictEqual(h.calls[0].proc.killed, true);
  assert.strictEqual(h.timers[0].cleared, true);
  assert.deepStrictEqual(h.logs, []);
  h.advance(INTERVAL_MS * 2);
  assert.strictEqual(h.refresher.seen(), false);
  assert.strictEqual(h.refresher.refreshNow(), false);
  assert.strictEqual(h.calls.length, 1);
});

test('a child that ignores SIGTERM is logged at the timeout, killed with SIGKILL, and does not block later runs', () => {
  const h = harness();
  h.refresher.seen();
  const proc = h.last();
  const signals = [];
  proc.kill = (signal) => { signals.push(signal || 'SIGTERM'); return true; };
  h.timers[0].fn();
  assert.strictEqual(h.logs.length, 1);
  assert.match(h.logs[0], /took over 90 s/);
  assert.strictEqual(h.timers[1].ms, KILL_GRACE_MS);
  h.timers[1].fn();
  assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.strictEqual(h.refresher.running(), false);
  proc.emit('exit', null, 'SIGKILL');
  assert.strictEqual(h.logs.length, 1);
  h.advance(INTERVAL_MS);
  assert.strictEqual(h.refresher.seen(), true);
});
