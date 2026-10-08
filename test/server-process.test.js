'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { bootServer, tmpDir } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

// A child server with its config, rtk database and changes file all in a temp folder.
function runServer(t, args) {
  const base = tmpDir(t, 'server-proc');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: base,
    RTK_DB: path.join(base, 'no-rtk-here.db'),
    CHANGES_FILE: path.join(base, 'changes.json'),
  };
  delete env.PORT;
  return spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 15_000 });
}

test('a port that is not a number exits 1 and says so', (t) => {
  const res = runServer(t, ['--port', 'abc']);
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /Invalid port "abc"/);
});

test('a port above 65535 exits 1 and says so', (t) => {
  const res = runServer(t, ['--port', '70000']);
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /Invalid port "70000"/);
});

test('a second server on a port that is in use exits 1 and says so', async (t) => {
  const { port } = await bootServer(t);
  const res = runServer(t, ['--port', String(port)]);
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /already in use/);
});
