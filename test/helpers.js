'use strict';

// Shared fixtures for the test files. Not a test file itself, so the
// `test/*.test.js` glob does not run it.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

module.exports = { tmpDir, removeTree, withEnv, bootServer };
