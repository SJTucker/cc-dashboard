'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bin', 'server');

// A fake HOME with a stub node on PATH. The stub prints its arguments and the line
// server.js prints once it listens, then waits for SIGTERM. It exits on its own
// after 30 seconds, so a failed test cannot leave it running. STUB_FAIL makes it
// exit at once, the way server.js does when its port is taken. /usr/bin and /bin
// supply ps, grep, sleep and kill. The env is built from scratch so no test can
// reach the developer's real ~/.claude.
function sandbox(t) {
  // after hooks run in the order they were added. This one stops the server
  // before tmpDir's hook removes the folder that holds its pid file.
  let box = null;
  t.after(() => box && run(box, ['stop']));
  const home = fs.realpathSync(helpers.tmpDir(t, 'server'));
  const stubs = path.join(home, 'stubs');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'node'), `#!/bin/sh
echo "args $*"
if [ -n "\${STUB_FAIL:-}" ]; then echo "Port 3600 is already in use."; exit 1; fi
echo "Claude Code Dashboard running at http://localhost:3600"
trap 'exit 0' TERM
i=0
while [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
`, { mode: 0o755 });
  box = { home, dir: path.join(home, '.claude', 'cc-dashboard'), env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` } };
  return box;
}

function run(box, args, env = {}) {
  const res = spawnSync('/bin/sh', [SCRIPT, ...args], { cwd: box.home, env: { ...box.env, ...env }, encoding: 'utf8' });
  return { code: res.status, out: res.stdout + res.stderr };
}

const pidOf = (box) => Number(fs.readFileSync(path.join(box.dir, 'server.pid'), 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('start runs the server in the background, and stop ends it', (t) => {
  const box = sandbox(t);
  let res = run(box, ['start']);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /Started \(pid \d+\) at http:\/\/localhost:3600/);
  const pid = pidOf(box);
  assert.ok(alive(pid));

  res = run(box, ['status']);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, new RegExp(`Running \\(pid ${pid}\\) at http://localhost:3600`));

  res = run(box, ['start']);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /Already running/);
  assert.strictEqual(pidOf(box), pid);

  res = run(box, ['stop']);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, new RegExp(`Stopped \\(pid ${pid}\\)`));
  assert.ok(!alive(pid));
  assert.ok(!fs.existsSync(path.join(box.dir, 'server.pid')));

  res = run(box, ['status']);
  assert.strictEqual(res.code, 1, res.out);
  assert.match(res.out, /Not running/);
});

test('restart starts a new server with the given arguments', (t) => {
  const box = sandbox(t);
  assert.strictEqual(run(box, ['start']).code, 0);
  const first = pidOf(box);
  const res = run(box, ['restart', '--port', '3601']);
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /Stopped[\s\S]*Started/);
  assert.ok(!alive(first));
  assert.notStrictEqual(pidOf(box), first);
  assert.match(fs.readFileSync(path.join(box.dir, 'server.log'), 'utf8'), /server\.js --port 3601$/m);
});

test('a server that exits at start prints its output and leaves no pid file', (t) => {
  const box = sandbox(t);
  const res = run(box, ['start'], { STUB_FAIL: '1' });
  assert.strictEqual(res.code, 1, res.out);
  assert.match(res.out, /already in use/);
  assert.ok(!fs.existsSync(path.join(box.dir, 'server.pid')));
});

test('a pid file naming another program counts as not running', (t) => {
  const box = sandbox(t);
  fs.mkdirSync(box.dir, { recursive: true });
  fs.writeFileSync(path.join(box.dir, 'server.pid'), `${process.pid}\n`);
  assert.strictEqual(run(box, ['status']).code, 1);
  const res = run(box, ['start']);
  assert.strictEqual(res.code, 0, res.out);
  assert.notStrictEqual(pidOf(box), process.pid);
});

test('CLAUDE_CONFIG_DIR moves the pid file and log', (t) => {
  const box = sandbox(t);
  const cfg = path.join(box.home, 'other');
  const res = run(box, ['start'], { CLAUDE_CONFIG_DIR: cfg });
  assert.strictEqual(res.code, 0, res.out);
  assert.ok(fs.existsSync(path.join(cfg, 'cc-dashboard', 'server.pid')));
  assert.ok(fs.existsSync(path.join(cfg, 'cc-dashboard', 'server.log')));
  assert.strictEqual(run(box, ['stop'], { CLAUDE_CONFIG_DIR: cfg }).code, 0);
});

test('an unknown command prints usage', (t) => {
  const box = sandbox(t);
  const res = run(box, ['go']);
  assert.strictEqual(res.code, 2);
  assert.match(res.out, /Usage: bin\/server start\|stop\|restart\|status/);
});

test('bin/server is executable', () => {
  assert.doesNotThrow(() => fs.accessSync(SCRIPT, fs.constants.X_OK));
});
