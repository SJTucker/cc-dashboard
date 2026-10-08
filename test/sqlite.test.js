'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Each module loads in a fresh process, because node:sqlite prints its warning only
// the first time it loads in a process.
for (const mod of ['./lib/sqlite', './lib/db', './lib/rtk']) {
  test(`loading ${mod} prints nothing on stderr`, () => {
    const out = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stderr, '');
  });
}

test('lib/sqlite.js exports the DatabaseSync class of node:sqlite', () => {
  assert.strictEqual(require('../lib/sqlite').DatabaseSync, require('node:sqlite').DatabaseSync);
});

test('a warning other than the SQLite one still prints after lib/sqlite.js loads', () => {
  const script = "require('./lib/sqlite'); process.emitWarning('a different warning');";
  const out = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stderr, /a different warning/);
});
