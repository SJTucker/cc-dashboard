'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, removeTree } = require('./helpers');

test('tmpDir makes a cc-dash folder under the OS temp dir and removes it when the test ends', async (t) => {
  let dir;
  await t.test('inner', (inner) => {
    dir = tmpDir(inner, 'helpers');
    assert.strictEqual(path.dirname(dir), os.tmpdir());
    assert.match(path.basename(dir), /^cc-dash-helpers-/);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    assert.ok(fs.existsSync(dir));
  });
  assert.strictEqual(fs.existsSync(dir), false, 'the inner test is over, so its folder is gone');
});

test('tmpDir with no test context removes the folder when the process exits', () => {
  const script = `
    const { tmpDir } = require(${JSON.stringify(path.join(__dirname, 'helpers'))});
    const dir = tmpDir(null, 'helpers-exit');
    require('fs').writeFileSync(require('path').join(dir, 'f.txt'), 'x');
    process.stdout.write(dir);
  `;
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /cc-dash-helpers-exit-/);
  assert.strictEqual(fs.existsSync(res.stdout), false);
});

test(
  'removeTree removes a tree that holds a folder with mode 000',
  { skip: process.getuid?.() === 0 && 'root can read a mode-000 folder' },
  () => {
    const dir = tmpDir(null, 'helpers-locked');
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'f.txt'), 'x');
    fs.chmodSync(locked, 0o000);
    removeTree(dir);
    assert.strictEqual(fs.existsSync(dir), false);
  },
);

test('removeTree does not throw when the folder is already gone', () => {
  assert.doesNotThrow(() => removeTree(path.join(os.tmpdir(), 'cc-dash-helpers-never-existed')));
});
