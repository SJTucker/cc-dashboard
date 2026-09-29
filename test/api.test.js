'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDateStr } = require('../lib/scan');

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

  // Without this the route would read the developer's real rtk database and the
  // assertions below would depend on their shell history.
  process.env.RTK_DB = path.join(base, 'no-rtk-here.db');

  delete process.env.LIVE_SESSIONS_DIR; // snapshots resolve under CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.PORT = '0'; // let the OS pick a free port
  delete require.cache[require.resolve('../lib/scan')];
  delete require.cache[require.resolve('../lib/sessions')];
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

  // Past getTodayScan's 2s share window, as every live poll is.
  await new Promise((resolve) => setTimeout(resolve, 2100));
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

test('GET /api/rtk returns an empty payload when there is no rtk database', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rtk?days=30`);
  const data = await res.json();

  assert.strictEqual(res.status, 200, 'a missing rtk database is not an error');
  assert.strictEqual(data.meta.dbExists, false);
  assert.deepStrictEqual(data.daily, []);
  assert.strictEqual(data.summary.totalCommands, 0);
});

test('GET /api/rtk rejects a malformed days value the same way /api/summary does', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rtk?days=-3`);
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Invalid days/);
});

test('GET /api/rtk?days=today buckets by hour', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rtk?days=today`);
  const data = await res.json();
  assert.strictEqual(res.status, 200);
  // No fixture rows, so the assertion is on shape, not content.
  assert.ok(Array.isArray(data.daily));
});

test('GET /api/summary does not send the per-call efficiency records', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  for (const days of ['today', '30']) {
    const data = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=${days}`)).json();
    assert.strictEqual(data.efficiency, undefined, `days=${days} must not include efficiency`);
  }
});

test('two concurrent cold requests for the same range call scanUsage once', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-inflight-'));
  const dir = path.join(base, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    requestId: 'req-1',
    message: { id: 'msg-1', model: 'claude-sonnet-4-6-20260115', usage: { input_tokens: 100, output_tokens: 20 } },
  });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), line + '\n');

  process.env.RTK_DB = path.join(base, 'no-rtk-here.db');
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../lib/scan')];
  const scanModule = require('../lib/scan');
  let calls = 0;
  const realScanUsage = scanModule.scanUsage;
  // A spy on the real scan, not a fake result: the point is counting runs, and the
  // response still has to be the genuine scan output for the assertions to mean
  // anything. There is no seam to count invocations through the HTTP API alone,
  // since a cache hit and a shared in-flight promise return the same response shape.
  scanModule.scanUsage = (...args) => {
    calls += 1;
    return realScanUsage(...args);
  };
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  t.after(() => {
    scanModule.scanUsage = realScanUsage;
    server.close();
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const port = server.address().port;
  const [a, b] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/summary?days=30`),
    fetch(`http://127.0.0.1:${port}/api/summary?days=30`),
  ]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(calls, 1, 'the second cold request awaited the first scan instead of starting its own');
});

// A fixture with one session that starts on Sep 1 and one on Sep 10, and a
// changes.json marker on Sep 5 between them.
function startChangesServer({ changes, plugins } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-changes-api-'));
  const dir = path.join(base, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const line = (iso, id, sessionId, context) => JSON.stringify({
    type: 'assistant', timestamp: iso, sessionId, requestId: 'req-' + id,
    message: { id: 'msg-' + id, model: 'claude-opus-5', content: [], usage: { input_tokens: context, output_tokens: 10 } },
  });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [
    line('2026-09-01T15:00:00Z', 'a', 's1', 40000),
    line('2026-09-10T15:00:00Z', 'b', 's2', 50000),
  ].join('\n') + '\n');
  if (plugins) {
    fs.mkdirSync(path.join(base, 'plugins'));
    fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'), JSON.stringify(plugins));
  }
  const changesPath = path.join(base, 'changes.json');
  if (changes) fs.writeFileSync(changesPath, JSON.stringify(changes));
  process.env.CHANGES_FILE = changesPath;
  process.env.RTK_DB = path.join(base, 'no-rtk-here.db');
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.PORT = '0';
  for (const mod of ['../lib/scan', '../lib/changes', '../lib/efficiency', '../server']) delete require.cache[require.resolve(mod)];
  return { server: require('../server'), changesPath };
}

test('GET /api/changes returns sessions and before/after windows per marker', async (t) => {
  const { server } = startChangesServer({ changes: [{ date: '2026-09-05T12:00', kind: 'skill', label: 'a skill' }] });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/changes`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.sessions.map((s) => s.context), [40000, 50000]);
  assert.strictEqual(data.markers.length, 1);
  const m = data.markers[0];
  assert.strictEqual(m.label, 'a skill');
  assert.strictEqual(m.before.sessionStart, 40000);
  assert.strictEqual(m.after.sessionStart, 50000);
  assert.strictEqual(m.before.rtk, null, 'no rtk database in the fixture');
  assert.strictEqual(data.changesFile.status, 'ok');
});

test('GET /api/changes re-reads changes.json on every request', async (t) => {
  const { server, changesPath } = startChangesServer({ changes: [] });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/changes`;

  assert.strictEqual((await (await fetch(url)).json()).markers.length, 0);
  fs.writeFileSync(changesPath, JSON.stringify([{ date: '2026-09-05T12:00', kind: 'hook', label: 'new hook' }]));
  const second = await (await fetch(url)).json();
  assert.deepStrictEqual(second.markers.map((m) => m.label), ['new hook'], 'the scan is cached, the marker file is not');
});

test('GET /api/changes works with no marker sources at all', async (t) => {
  const { server } = startChangesServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/changes`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.markers, []);
  assert.strictEqual(data.changesFile.status, 'missing');
});

test('GET /api/limits sends only the limits', async (t) => {
  delete process.env.CLAUDE_JSON;
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const resets = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'someone@example.com' },
    cachedUsageUtilization: {
      fetchedAtMs: 123,
      accountUuid: 'acct-1',
      utilization: { five_hour: { utilization: 6, resets_at: resets, used_dollars: null } },
    },
  }));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/limits`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    fetchedAt: 123,
    limits: [{ key: 'five_hour', label: 'Current session', percent: 6, resetsAt: Date.parse(resets) }],
    source: 'usage-cache',
  });
});

test('GET /api/limits returns null when there is no usage cache', async (t) => {
  delete process.env.CLAUDE_JSON;
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/limits`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.json(), null);
});

test('GET /api/records returns the all-time busiest day', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/records`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data, { allTime: { date: localDateStr(new Date()), tokens: 1200 } });
});

test('GET /stats.js serves the shared statistics helpers', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/stats.js`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(await res.text(), /function percentile/);
});

function writeSnapshot(base, snap) {
  const dir = path.join(base, 'cc-dashboard', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snap.sessionId}.json`), JSON.stringify(snap));
  return dir;
}

function appendCall(base, { sessionId, id, input, output }) {
  const now = new Date();
  now.setHours(10, 30, 0, 0);
  fs.appendFileSync(path.join(base, 'projects', 'demo', 'session.jsonl'), JSON.stringify({
    timestamp: now.toISOString(),
    requestId: `req-${id}`,
    sessionId,
    message: { id: `msg-${id}`, model: 'claude-sonnet-4-6-20260115', usage: { input_tokens: input, output_tokens: output } },
  }) + '\n');
}

test('GET /api/sessions/live joins today\'s snapshots with scanned tokens', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = process.env.CLAUDE_CONFIG_DIR;
  appendCall(base, { sessionId: 'sess-a', id: 'a1', input: 700, output: 300 });
  writeSnapshot(base, {
    sessionId: 'sess-a', lastActiveAt: Date.now() - 30_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.42, durationMs: 90_000, apiDurationMs: 20_000, linesAdded: 5, linesRemoved: 1,
  });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.sessions.length, 1);
  assert.strictEqual(body.sessions[0].tokens, 1000);
  assert.strictEqual(body.sessions[0].live, true);
  assert.strictEqual(body.sessions[0].project, 'demo');
  assert.strictEqual('sessionId' in body.sessions[0], false);
  assert.deepStrictEqual(body.total, { costUsd: 0.42, apiDurationMs: 20_000, linesAdded: 5, linesRemoved: 1, tokens: 1000 });
});

test('GET /api/sessions/live is empty with no snapshot directory', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    sessions: [],
    total: { costUsd: 0, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 },
  });
});

test('GET /api/sessions/live skips a corrupt snapshot and serves the rest', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = process.env.CLAUDE_CONFIG_DIR;
  const dir = writeSnapshot(base, {
    sessionId: 'ok', lastActiveAt: Date.now() - 1000, project: 'demo', model: null,
    costUsd: 1, durationMs: 1, apiDurationMs: 1, linesAdded: 0, linesRemoved: 0,
  });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"sessionId":');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).sessions.length, 1);
});

test('the Today scan is shared between /api/summary and /api/sessions/live', async (t) => {
  const server = startServer();
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = process.env.CLAUDE_CONFIG_DIR;
  writeSnapshot(base, {
    sessionId: 'sess-b', lastActiveAt: Date.now() - 1000, project: 'demo', model: null,
    costUsd: 1, durationMs: 1, apiDurationMs: 1, linesAdded: 0, linesRemoved: 0,
  });
  // Requested together, the way loadAndRender sends them.
  const [summary] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/summary?days=today`).then((r) => r.json()),
    fetch(`http://127.0.0.1:${port}/api/sessions/live`).then((r) => r.json()),
  ]);
  // A line appended right after is not in a scan shared within 2 seconds...
  appendCall(base, { sessionId: 'sess-b', id: 'b1', input: 10, output: 0 });
  const live = await (await fetch(`http://127.0.0.1:${port}/api/sessions/live`)).json();
  assert.strictEqual(live.sessions[0].tokens, 0);
  assert.strictEqual(summary.summary.totalOutput, 200);
  // ...and is after the share window, which a 5s live poll always is.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const later = await (await fetch(`http://127.0.0.1:${port}/api/sessions/live`)).json();
  assert.strictEqual(later.sessions[0].tokens, 10);
});
