'use strict';

const fs = require('fs');
const path = require('path');
const { spawn: spawnProcess } = require('child_process');

// Keeps Claude Code's /usage cache in .claude.json fresh while a dashboard page is
// open. Claude Code writes that cache only when its usage fetch runs, and a headless
// `claude -p /usage` runs that fetch. The cache is the only source of the scoped
// weekly rows and usage credits that lib/limits.js reads. The child uses Claude
// Code's own login, so the dashboard never reads a token. --no-session-persistence
// stops the child writing a transcript. Its output is not read, because the cache
// write is the reason to run it.

const ARGS = ['-p', '--no-session-persistence', '/usage'];
// A poll starts a run only when the cache is at least this old and no run started
// this recently. The page polls /api/limits every 5 s while it is open, so runs stop
// when no page is open.
const INTERVAL_MS = 5 * 60 * 1000;
// Claude Code answers /usage from its cache when the cache is younger than this, so a
// run before then would not fetch.
const FRESH_MS = 60 * 1000;
// A run still going after this long is logged and sent SIGTERM.
const TIMEOUT_MS = 90 * 1000;
// A run still going this long after its SIGTERM is sent SIGKILL and counted as over,
// so a child that ignores SIGTERM (blocked on a prompt) does not stop later runs.
const KILL_GRACE_MS = 5 * 1000;

// The child's working folder. A fixed folder keeps Claude Code to one project folder
// under <cfg>/projects/ for these runs.
function getUsageRefreshDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'usage-refresh');
}

// One run at a time. lastFetchedAt returns the cache's fetchedAtMs or null. A failure
// is logged once per kind (missing binary, could not start, non-zero exit, timeout)
// until a run succeeds. stop() kills a running child, and nothing starts after it.
function createUsageRefresher({
  bin, cwd, lastFetchedAt, spawn = spawnProcess, now = Date.now,
  log = (line) => console.warn(line), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let child = null;
  let killTimer = null;
  let lastRunAt = null;
  let stopped = false;
  const warned = new Set();

  function warnOnce(kind, message) {
    if (warned.has(kind)) return;
    warned.add(kind);
    log(`[usage] ${message}`);
  }

  // Starts a run when the cache is at least minAgeMs old. Returns whether it started.
  function run(minAgeMs) {
    if (stopped || child) return false;
    const fetchedAt = lastFetchedAt();
    if (typeof fetchedAt === 'number' && now() - fetchedAt < minAgeMs) return false;
    lastRunAt = now();
    let proc;
    try {
      fs.mkdirSync(cwd, { recursive: true });
      proc = spawn(bin, ARGS, { cwd, stdio: 'ignore' });
    } catch (err) {
      warnOnce('start', `could not start ${bin}: ${err.message}`);
      return false;
    }
    child = proc;
    let timedOut = false;
    let done = false;
    const end = (failure) => {
      if (done) return;
      done = true;
      clearTimer(killTimer);
      killTimer = null;
      child = null;
      if (failure) warnOnce(failure.kind, failure.message);
      else if (!stopped && !timedOut) warned.clear();
    };
    killTimer = setTimer(() => {
      timedOut = true;
      warnOnce('timeout', `${bin} -p /usage took over ${TIMEOUT_MS / 1000} s and was stopped`);
      proc.kill();
      if (done) return;
      killTimer = setTimer(() => {
        proc.kill('SIGKILL');
        end(null);
      }, KILL_GRACE_MS);
    }, TIMEOUT_MS);
    proc.on('error', (err) => end(err.code === 'ENOENT'
      ? { kind: 'missing', message: `${bin} was not found. Set CC_DASHBOARD_CLAUDE_BIN to the claude binary.` }
      : { kind: 'start', message: `could not start ${bin}: ${err.message}` }));
    proc.on('exit', (code, signal) => {
      if (stopped || timedOut) end(null);
      else if (code === 0) end(null);
      else end({ kind: 'exit', message: `${bin} -p /usage exited with ${code ?? signal}` });
    });
    return true;
  }

  return {
    // Called on each GET /api/limits.
    seen() {
      if (lastRunAt != null && now() - lastRunAt < INTERVAL_MS) return false;
      return run(INTERVAL_MS);
    },
    // Called on POST /api/refresh.
    refreshNow() {
      return run(FRESH_MS);
    },
    stop() {
      stopped = true;
      clearTimer(killTimer);
      if (child) child.kill();
    },
    running() {
      return child != null;
    },
  };
}

module.exports = { createUsageRefresher, getUsageRefreshDir, ARGS, INTERVAL_MS, FRESH_MS, TIMEOUT_MS, KILL_GRACE_MS };
