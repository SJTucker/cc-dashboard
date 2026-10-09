'use strict';

// Shared fixtures for the test files. Not a test file itself, so the
// `test/*.test.js` glob does not run it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// A test that chmods a folder to 000 leaves rmSync unable to list it. Making each
// directory in the tree 0o700 again lets the second removal succeed.
function makeWritable(dir) {
  let entries;
  try {
    fs.chmodSync(dir, 0o700);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  }
}

// Never throws. A folder left in the temp dir does no harm, and a cleanup failure
// must not fail a test.
function removeTree(dir) {
  const options = { recursive: true, force: true, maxRetries: 3, retryDelay: 20 };
  try {
    fs.rmSync(dir, options);
    return;
  } catch {
    // fall through to the permission repair below
  }
  makeWritable(dir);
  try {
    fs.rmSync(dir, options);
  } catch {
    // leave it
  }
}

const exitDirs = new Set();
let exitHookInstalled = false;

// Folders for callers that have no test context (a fixture builder called from many
// places). `node --test` runs each file in its own process, so 'exit' fires once per file.
function removeAtExit(dir) {
  exitDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const leftover of exitDirs) removeTree(leftover);
  });
}

// `t` is a node:test context, or null. With a context the folder goes when that test
// ends. With null it goes when the process exits.
function tmpDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-dash-${name}-`));
  if (t) t.after(() => removeTree(dir));
  else removeAtExit(dir);
  return dir;
}

// t.after hooks run in registration order. Restoring each call's own saved value in
// that order would leave the second call's stale value in place. So the first call
// for a test records the original of each key, and later calls only add keys.
const savedByTest = new WeakMap();

function setOrDelete(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
}

function withEnv(t, vars) {
  let saved = savedByTest.get(t);
  if (!saved) {
    saved = new Map();
    savedByTest.set(t, saved);
    t.after(() => {
      for (const [key, value] of saved) setOrDelete(key, value);
    });
  }
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    setOrDelete(key, value);
  }
}

// Boots the real server.js on an ephemeral port against an empty config dir. The
// variables are set before server.js is required because it reads them at load time.
function bootServer(t) {
  const base = tmpDir(t, 'boot');
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  withEnv(t, {
    CLAUDE_CONFIG_DIR: base,
    RTK_DB: path.join(base, 'no-rtk-here.db'),
    CHANGES_FILE: path.join(base, 'changes.json'),
    PORT: '0',
  });
  const serverPath = path.join(__dirname, '..', 'server');
  delete require.cache[require.resolve(serverPath)];
  const server = require(serverPath);
  t.after(() => server.close());
  return new Promise((resolve) => {
    server.once('listening', () => resolve({ server, port: server.address().port, base }));
  });
}

// Holds the write lock on the SQLite file `file` from a child process, as
// bin/review-session does while it records a review. Resolves once BEGIN IMMEDIATE
// has succeeded, with release(). release() closes the child's stdin, the child
// commits and exits, and the promise release() returns resolves on that exit.
// t.after kills a child the test did not release. The file must exist first
// (openDatabase(file).close()). Otherwise the child creates it empty and outside WAL
// mode, and the test measures a different lock.
function holdWriteLock(t, file) {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('locked\\n');",
    "process.stdin.on('end', () => { db.exec('COMMIT'); db.close(); });",
    'process.stdin.resume();',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, file], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    exited.then((code) => reject(new Error(`the lock holder exited with code ${code} before it took the lock`)));
    child.stdout.once('data', () => resolve(() => {
      child.stdin.end();
      return exited;
    }));
  });
}

// lib/db.js keeps the server's handle at module level. lib/rowstore.js keeps the row
// store and lib/review-db.js keeps the import flag. This points CLAUDE_CONFIG_DIR at
// a new temp folder and drops the cached copies of those modules and of lib/store.js
// and lib/review.js, which load lib/db.js, so the test's next require starts with no
// handle. The handle is closed after the test, before the folder is removed.
const SERVER_DB_MODULES = ['../lib/db', '../lib/store', '../lib/rowstore', '../lib/review', '../lib/review-db'];
function freshServerDb(t) {
  let dbModule = null;
  t.after(() => dbModule && dbModule.closeServerDb());
  const base = tmpDir(t, 'serverdb');
  withEnv(t, { CLAUDE_CONFIG_DIR: base });
  for (const mod of SERVER_DB_MODULES) delete require.cache[require.resolve(mod)];
  dbModule = require('../lib/db');
  return { dbModule, base, file: dbModule.getStorePath() };
}

module.exports = { tmpDir, removeTree, withEnv, bootServer, holdWriteLock, freshServerDb };
