'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const { bootServer, tmpDir } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

// Environment for a child server with its config, rtk database and changes file all in `base`.
function serverEnv(base) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: base,
    RTK_DB: path.join(base, 'no-rtk-here.db'),
    CHANGES_FILE: path.join(base, 'changes.json'),
  };
}

// A child server run to completion.
function runServer(t, args) {
  const env = serverEnv(tmpDir(t, 'server-proc'));
  delete env.PORT;
  return spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 15_000 });
}

test('a port that is not a number exits 1 and says so', (t) => {
  const res = runServer(t, ['--port', 'abc']);
  assert.strictEqual(res.status, 1, `${res.error || ''} ${res.stderr}`);
  assert.match(res.stderr, /Invalid port "abc"/, String(res.error || res.stderr));
});

test('a port above 65535 exits 1 and says so', (t) => {
  const res = runServer(t, ['--port', '70000']);
  assert.strictEqual(res.status, 1, `${res.error || ''} ${res.stderr}`);
  assert.match(res.stderr, /Invalid port "70000"/, String(res.error || res.stderr));
});

test('a second server on a port that is in use exits 1 and says so', async (t) => {
  const { port } = await bootServer(t);
  const res = runServer(t, ['--port', String(port)]);
  assert.strictEqual(res.status, 1, `${res.error || ''} ${res.stderr}`);
  assert.match(res.stderr, /already in use/, String(res.error || res.stderr));
});

// Spawns node server.js on a free port with its own config folder, and resolves once
// the startup banner has printed. PORT=0 would work, but the banner prints PORT, not
// the bound port, so the test picks a free port first.
async function startServerProcess(t) {
  const base = tmpDir(t, 'shutdown');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...serverEnv(base), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('running at')) resolve();
    });
    exited.then(({ code }) => reject(new Error(`the server exited with code ${code} before it listened. stderr: ${err}`)));
  });
  return { child, exited, url: `http://127.0.0.1:${port}`, wal: path.join(base, 'cc-dashboard', 'transcripts.db-wal') };
}

const within = (promise, ms) => Promise.race([promise, delay(ms, 'timeout')]);

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} closes transcripts.db and exits 0 within 2 s, leaving no WAL behind`, async (t) => {
    const server = await startServerProcess(t);
    assert.strictEqual((await fetch(`${server.url}/api/reviews`)).status, 200); // opens the database
    assert.ok(fs.existsSync(server.wal), 'the open database has a WAL file');
    server.child.kill(signal);
    assert.deepStrictEqual(await within(server.exited, 2000), { code: 0, signal: null });
    assert.ok(!fs.existsSync(server.wal) || fs.statSync(server.wal).size === 0, 'the WAL was folded into transcripts.db');
  });
}

// Two requests on one keep-alive agent, so the row store (/api/summary) and the
// reviews (/api/reviews) have both used the transcripts.db handle. The connection
// stays open when the signal arrives.
for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} with an open keep-alive connection exits 0 and leaves no WAL file`, async (t) => {
    const server = await startServerProcess(t);
    const { port } = new URL(server.url);
    const agent = new http.Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    const get = (route) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: route, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.strictEqual(await get('/api/summary?days=7'), 200);
    assert.strictEqual(await get('/api/reviews'), 200);
    const started = Date.now();
    server.child.kill(signal);
    assert.deepStrictEqual(await within(server.exited, 3000), { code: 0, signal: null });
    assert.ok(Date.now() - started < 3000, `exit took ${Date.now() - started} ms`);
    assert.ok(!fs.existsSync(server.wal), 'transcripts.db-wal is gone');
  });
}

test('SIGTERM before any request, with no database open, exits 0', async (t) => {
  const server = await startServerProcess(t);
  server.child.kill('SIGTERM');
  assert.deepStrictEqual(await within(server.exited, 2000), { code: 0, signal: null });
});
