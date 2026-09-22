'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Boot the real Express app on an ephemeral port against a fixture log directory.
// CLAUDE_CONFIG_DIR has to be set before server.js is required, because
// getProjectsDir() reads it when lib/scan.js is loaded into the module cache.
function startServer() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-api-'));
  const dir = path.join(base, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  now.setHours(10, 0, 0, 0);
  const line = JSON.stringify({
    timestamp: now.toISOString(),
    requestId: 'req-1',
    message: {
      id: 'msg-1',
      model: 'claude-sonnet-4-6-20260115',
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
  });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), line + '\n');

  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.PORT = '0'; // let the OS pick a free port
  delete require.cache[require.resolve('../lib/scan')];
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  return server;
}

test('GET /api/summary?days=today returns one bucket per local hour', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/summary?days=today`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  // 23 on the spring-forward day, where 2am does not exist locally.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const expectedSlots = Math.min(Math.round((nextDay - dayStart) / 3600000), 24);
  assert.strictEqual(data.daily.length, expectedSlots, 'today is bucketed by hour');
  assert.strictEqual(data.summary.totalInput, 1000);

  const ten = data.daily.find((d) => d.date.endsWith('T10'));
  assert.strictEqual(ten.input, 1000, 'the 10:00 slot holds the fixture usage');
});

test('GET /api/summary?days=today is not served from the 60s cache', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const port = server.address().port;
  const first = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=today`)).json();
  assert.strictEqual(first.summary.totalOutput, 200);

  // Append a second entry, then request again with no /api/refresh call in between.
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'demo');
  const now = new Date();
  now.setHours(11, 0, 0, 0);
  const line = JSON.stringify({
    timestamp: now.toISOString(),
    requestId: 'req-2',
    message: {
      id: 'msg-2',
      model: 'claude-sonnet-4-6-20260115',
      usage: { input_tokens: 0, output_tokens: 300 },
    },
  });
  fs.appendFileSync(path.join(dir, 'session.jsonl'), line + '\n');

  const second = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=today`)).json();
  assert.strictEqual(second.summary.totalOutput, 500, 'the new entry appears without a manual refresh');
});

test('GET /api/summary rejects a days value it cannot honour', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const get = (qs) => fetch(`http://127.0.0.1:${port}/api/summary${qs}`);

  // Each of these used to return the 30-day rollup while looking like it had
  // honoured the request.
  for (const qs of ['?days=0', '?days=abc', '?days=-5', '?days=1.5']) {
    const res = await get(qs);
    assert.strictEqual(res.status, 400, `${qs} is rejected`);
  }

  assert.strictEqual((await get('?days=7')).status, 200, 'a real range still works');
  assert.strictEqual((await get('?days=all')).status, 200, "'all' still works");
  assert.strictEqual((await get('')).status, 200, 'an absent days still defaults');
});

test('POST /api/refresh refuses a cross-site request', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/refresh`;

  // A browser sets Host from the address it connected to, so the Host guard
  // cannot tell these apart. Sec-Fetch-Site can.
  const crossSite = await fetch(url, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(crossSite.status, 403, 'another page cannot clear the cache');

  const sameOrigin = await fetch(url, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(sameOrigin.status, 200, 'the dashboard itself still can');

  const noHeader = await fetch(url, { method: 'POST' });
  assert.strictEqual(noHeader.status, 200, 'a non-browser client still can');
});
