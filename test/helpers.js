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

// A config for one test, built by loadConfig, with every path in a fresh temp
// folder. projects/demo exists, so the server has a transcript folder to walk.
// rtkDb names a file that does not exist, so no test reads the developer's rtk
// history.
function testConfig(t, name = 'cfg') {
  const { loadConfig } = require('../lib/config-dir');
  const base = tmpDir(t, name);
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  return loadConfig({
    CLAUDE_CONFIG_DIR: base,
    CHANGES_FILE: path.join(base, 'changes.json'),
    RTK_DB: path.join(base, 'no-rtk-here.db'),
  });
}

// The modules that hold server state or read the environment when loaded. Until
// server.js exports a factory (B2 Task 13), each boot reloads them, so every server
// starts from fresh copies.
const SERVER_MODULES = [
  '../server', '../lib/aggregate', '../lib/rowstore', '../lib/store', '../lib/db', '../lib/review-db',
  '../lib/review', '../lib/sessions', '../lib/updates', '../lib/changes', '../lib/efficiency',
];

// Boots server.js on an ephemeral port with `config`, and resolves once it listens.
// Write fixtures under config.configDir before the first request, not before the
// boot: the row store opens on the first scan.
async function bootServer(t, config = testConfig(t, 'boot')) {
  withEnv(t, { CLAUDE_CONFIG_DIR: config.configDir, CHANGES_FILE: config.changesFile, RTK_DB: config.rtkDb, PORT: '0' });
  for (const mod of SERVER_MODULES) delete require.cache[require.resolve(mod)];
  const server = require('../server');
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    require('../lib/pricing').setSnapshots([]);
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return { server, config, port, url: `http://127.0.0.1:${port}` };
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

// A server handle on a fresh transcripts.db in a temp folder, closed after the test.
function freshServerDb(t) {
  const { createServerDb } = require('../lib/db');
  const base = tmpDir(t, 'serverdb');
  const file = path.join(base, 'transcripts.db');
  const serverDb = createServerDb(file);
  t.after(() => serverDb.close());
  return { serverDb, base, file };
}

module.exports = { tmpDir, removeTree, withEnv, testConfig, bootServer, holdWriteLock, freshServerDb };
