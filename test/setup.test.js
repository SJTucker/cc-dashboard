'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bin', 'setup');
const MOD = fs.realpathSync(path.join(__dirname, '..', 'mod'));

// A fake HOME with stub node, npm and claude on PATH. Each stub appends its name
// and arguments to calls.log, so a test can tell what ran. /usr/bin and /bin
// supply uname, dirname, readlink, mkdir and ln. The env is built from scratch so
// no test can reach the developer's real ~/.claude.
function sandbox(t, { node = '22.13.0', claude = true, validateExit = 0 } = {}) {
  const home = fs.realpathSync(helpers.tmpDir(t, 'setup'));
  const stubs = path.join(home, 'stubs');
  const log = path.join(home, 'calls.log');
  fs.mkdirSync(stubs);
  const stub = (name, body) =>
    fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  stub('node', `echo ${node}`);
  stub('npm', 'exit 0');
  if (claude) stub('claude', `exit ${validateExit}`);
  return { home, log, env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` } };
}

function run(box, env = {}, script = SCRIPT) {
  const res = spawnSync('/bin/sh', [script], { cwd: box.home, env: { ...box.env, ...env }, encoding: 'utf8' });
  const calls = fs.existsSync(box.log) ? fs.readFileSync(box.log, 'utf8') : '';
  return { code: res.status, out: res.stdout + res.stderr, calls };
}

const linkPath = (home, cfg = path.join(home, '.claude')) => path.join(cfg, 'skills', 'cc-dashboard');

test('a fresh run installs, links the mod and validates it', (t) => {
  const box = sandbox(t);
  const { code, out, calls } = run(box);
  assert.strictEqual(code, 0, out);
  assert.strictEqual(fs.readlinkSync(linkPath(box.home)), MOD);
  assert.match(calls, /^npm install$/m);
  assert.match(calls, new RegExp(`^claude plugin validate ${MOD}$`, 'm'));
  assert.match(out, /npm start/);
  assert.match(out, /http:\/\/localhost:3600/);
  const summary = out.slice(out.indexOf('Summary:'));
  assert.ok(summary.startsWith('Summary:'), out);
  let at = 0;
  for (const line of ['ok    node', 'ok    npm install', 'ok    linked', 'ok    claude plugin validate']) {
    const i = summary.indexOf(line, at);
    assert.ok(i >= 0, `${line} missing or out of order in:\n${summary}`);
    at = i + line.length;
  }
  assert.ok(summary.indexOf('Summary:') < summary.indexOf('Next:'), out);
});

test('bin/setup is executable', () => {
  assert.doesNotThrow(() => fs.accessSync(SCRIPT, fs.constants.X_OK));
});

test('a second run leaves the link alone', (t) => {
  const box = sandbox(t);
  run(box);
  const before = fs.lstatSync(linkPath(box.home)).ino;
  const { code, out } = run(box);
  assert.strictEqual(code, 0, out);
  assert.strictEqual(fs.lstatSync(linkPath(box.home)).ino, before);
  assert.match(out, /already points at/);
});

test('a relative link that resolves to this clone passes', (t) => {
  const box = sandbox(t);
  const link = linkPath(box.home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), MOD), link);
  const { code, out } = run(box);
  assert.strictEqual(code, 0, out);
  assert.strictEqual(fs.readlinkSync(link), path.relative(path.dirname(link), MOD));
});

test('a link that points elsewhere stops the script before npm install', (t) => {
  const box = sandbox(t);
  const link = linkPath(box.home);
  const other = path.join(box.home, 'other-mod');
  fs.mkdirSync(other);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(other, link);
  const { code, out, calls } = run(box);
  assert.strictEqual(code, 1);
  assert.match(out, /FAIL/);
  assert.ok(out.includes(other), out);
  assert.strictEqual(fs.readlinkSync(link), other);
  assert.doesNotMatch(calls, /npm install/);
});

test('a dangling link left by a moved clone stops the script', (t) => {
  const box = sandbox(t);
  const link = linkPath(box.home);
  const gone = path.join(box.home, 'moved-away', 'mod');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(gone, link);
  const { code, out, calls } = run(box);
  assert.strictEqual(code, 1);
  assert.ok(out.includes(gone), out);
  assert.strictEqual(fs.readlinkSync(link), gone);
  assert.doesNotMatch(calls, /npm install/);
});

test('a folder at the link path stops the script', (t) => {
  const box = sandbox(t);
  const link = linkPath(box.home);
  fs.mkdirSync(link, { recursive: true });
  const { code, out, calls } = run(box);
  assert.strictEqual(code, 1);
  assert.match(out, /is a folder/);
  assert.ok(fs.statSync(link).isDirectory());
  assert.doesNotMatch(calls, /npm install/);
});

for (const [version, passes] of [['20.11.0', false], ['22.12.0', false], ['22.13.0', true], ['23.0.0', true]]) {
  test(`node ${version} ${passes ? 'passes' : 'stops the script before npm install'}`, (t) => {
    const box = sandbox(t, { node: version });
    const { code, out, calls } = run(box);
    assert.strictEqual(code, passes ? 0 : 1, out);
    assert.ok(out.includes(version), out);
    if (!passes) assert.doesNotMatch(calls, /npm install/);
  });
}

test('a missing claude stops the script before npm install', (t) => {
  const box = sandbox(t, { claude: false });
  const { code, out, calls } = run(box);
  assert.strictEqual(code, 1);
  assert.match(out, /claude is not on PATH/);
  assert.doesNotMatch(calls, /npm install/);
  const summary = out.slice(out.indexOf('Summary:'));
  assert.ok(summary.startsWith('Summary:'), out);
  assert.match(summary.trimEnd().split('\n').pop(), /^FAIL {2}claude is not on PATH/);
});

test('CLAUDE_CONFIG_DIR with a leading ~ puts the link under HOME', (t) => {
  const box = sandbox(t);
  const { code, out } = run(box, { CLAUDE_CONFIG_DIR: '~/x' });
  assert.strictEqual(code, 0, out);
  assert.strictEqual(fs.readlinkSync(linkPath(box.home, path.join(box.home, 'x'))), MOD);
});

test('an empty CLAUDE_CONFIG_DIR counts as unset', (t) => {
  const box = sandbox(t);
  const { code, out } = run(box, { CLAUDE_CONFIG_DIR: '' });
  assert.strictEqual(code, 0, out);
  assert.strictEqual(fs.readlinkSync(linkPath(box.home)), MOD);
});

test('a failed plugin validate exits 1 and keeps the link', (t) => {
  const box = sandbox(t, { validateExit: 1 });
  const { code, out } = run(box);
  assert.strictEqual(code, 1);
  assert.match(out, /FAIL\s+claude plugin validate/);
  assert.strictEqual(fs.readlinkSync(linkPath(box.home)), MOD);
});

test('a clone path with a space links the right folder', (t) => {
  const box = sandbox(t);
  const clone = path.join(box.home, 'My Projects', 'cc-dashboard');
  fs.mkdirSync(path.join(clone, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(clone, 'mod'));
  fs.copyFileSync(SCRIPT, path.join(clone, 'bin', 'setup'));
  const { code, out, calls } = run(box, {}, path.join(clone, 'bin', 'setup'));
  assert.strictEqual(code, 0, out);
  assert.strictEqual(fs.readlinkSync(linkPath(box.home)), path.join(clone, 'mod'));
  assert.ok(calls.includes(`claude plugin validate ${path.join(clone, 'mod')}`), calls);
});
