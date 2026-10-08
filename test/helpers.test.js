'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, removeTree, withEnv } = require('./helpers');

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-helpers-locked-'));
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

test('withEnv sets variables and restores them, deleting a key that was unset before', async (t) => {
  delete process.env.CC_DASH_TEST_UNSET;
  process.env.CC_DASH_TEST_SET = 'before';
  t.after(() => { delete process.env.CC_DASH_TEST_SET; });
  await t.test('inner', (inner) => {
    withEnv(inner, { CC_DASH_TEST_UNSET: 'during', CC_DASH_TEST_SET: 'during' });
    assert.strictEqual(process.env.CC_DASH_TEST_UNSET, 'during');
    assert.strictEqual(process.env.CC_DASH_TEST_SET, 'during');
  });
  assert.strictEqual('CC_DASH_TEST_UNSET' in process.env, false);
  assert.strictEqual(process.env.CC_DASH_TEST_SET, 'before');
});

test('withEnv called twice for one key restores the value from before the first call', async (t) => {
  process.env.CC_DASH_TEST_TWICE = 'original';
  t.after(() => { delete process.env.CC_DASH_TEST_TWICE; });
  await t.test('inner', (inner) => {
    withEnv(inner, { CC_DASH_TEST_TWICE: 'first' });
    withEnv(inner, { CC_DASH_TEST_TWICE: 'second' });
    assert.strictEqual(process.env.CC_DASH_TEST_TWICE, 'second');
  });
  assert.strictEqual(process.env.CC_DASH_TEST_TWICE, 'original');
});

test('withEnv with undefined deletes the key for the test', async (t) => {
  process.env.CC_DASH_TEST_DEL = 'present';
  t.after(() => { delete process.env.CC_DASH_TEST_DEL; });
  await t.test('inner', (inner) => {
    withEnv(inner, { CC_DASH_TEST_DEL: undefined });
    assert.strictEqual('CC_DASH_TEST_DEL' in process.env, false);
  });
  assert.strictEqual(process.env.CC_DASH_TEST_DEL, 'present');
});
