'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers');
const { localDateStr } = require('../lib/scan');

// Boot the real Express app on an ephemeral port against a fixture log directory.
// CLAUDE_CONFIG_DIR has to be set before server.js is required, because
// getProjectsDir() reads it when lib/scan.js is loaded into the module cache.
function startServer(t) {
  const base = helpers.tmpDir(t, 'api');
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

  // RTK_DB: without it the route would read the developer's real rtk database and the
  // assertions below would depend on their shell history.
  // CLAUDE_CONFIG_DIR: snapshots, prices.json and transcripts.db (reviews included)
  // all resolve under it.
  // CHANGES_FILE: without it lib/changes.js falls back to the repo's own changes.json.
  // PORT: 0 lets the OS pick a free port.
  helpers.withEnv(t, {
    RTK_DB: path.join(base, 'no-rtk-here.db'),
    CLAUDE_CONFIG_DIR: base,
    CHANGES_FILE: path.join(base, 'changes.json'),
    PORT: '0',
  });
  // The row store keeps its rows and database handle at module level, so each
  // server starts from fresh copies.
  for (const mod of ['../lib/scan', '../lib/aggregate', '../lib/rowstore']) delete require.cache[require.resolve(mod)];
  delete require.cache[require.resolve('../lib/sessions')];
  delete require.cache[require.resolve('../lib/updates')];
  delete require.cache[require.resolve('../lib/review')];
  delete require.cache[require.resolve('../lib/db')];
  delete require.cache[require.resolve('../lib/review-db')];
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  return server;
}

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing-page.md'), 'utf8');

// server.js runs in this process, so its fetch of the pricing page goes through
// globalThis.fetch. Requests to the test server itself pass through.
function stubPricingPage(t, body, status = 200) {
  const { PRICING_URL } = require('../lib/price-fetch');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    String(url) === PRICING_URL ? Promise.resolve(new Response(body, { status })) : realFetch(url, opts);
  t.after(() => { globalThis.fetch = realFetch; });
}

// Same helper as in test/price-fetch.test.js: replaces price cells in the Model
// pricing row named `name`. `values` is [input, 5m write, 1h write, cache hit, output].
function withModelCells(md, name, values) {
  let done = false;
  return md.split('\n').map((line) => {
    const cells = line.split('|');
    if (done || cells.length < 3 || cells[1].trim() !== name) return line;
    done = true;
    values.forEach((v, i) => { if (v != null) cells[i + 2] = ` ${v} `; });
    return cells.join('|');
  }).join('\n');
}

async function listen(t) {
  const server = startServer(t);
  t.after(() => {
    server.close();
    require('../lib/pricing').setSnapshots([]);
  });
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('GET /api/summary?days=today returns one bucket per local hour', async (t) => {
  const server = startServer(t);
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

test('GET /api/summary?days=today is not served from the memo', async (t) => {
  const server = startServer(t);
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

  // Past the 2s refresh share, as every live poll is.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const second = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=today`)).json();
  assert.strictEqual(second.summary.totalOutput, 500, 'the new entry appears without a manual refresh');
});

test('GET /api/summary rejects a days value it cannot honour', async (t) => {
  const server = startServer(t);
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
  const server = startServer(t);
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
  const server = startServer(t);
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
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rtk?days=-3`);
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Invalid days/);
});

test('GET /api/rtk?days=today buckets by hour', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rtk?days=today`);
  const data = await res.json();
  assert.strictEqual(res.status, 200);
  // No fixture rows, so the assertion is on shape, not content.
  assert.ok(Array.isArray(data.daily));
});

test('GET /api/summary does not send the per-call efficiency records', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  for (const days of ['today', '30']) {
    const data = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=${days}`)).json();
    assert.strictEqual(data.efficiency, undefined, `days=${days} must not include efficiency`);
  }
});

test('two concurrent cold requests for the same range aggregate once', async (t) => {
  const base = helpers.tmpDir(t, 'inflight');
  const dir = path.join(base, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    requestId: 'req-1',
    message: { id: 'msg-1', model: 'claude-sonnet-4-6-20260115', usage: { input_tokens: 100, output_tokens: 20 } },
  });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), line + '\n');

  helpers.withEnv(t, {
    RTK_DB: path.join(base, 'no-rtk-here.db'),
    CLAUDE_CONFIG_DIR: base,
    CHANGES_FILE: path.join(base, 'changes.json'),
    PORT: '0',
  });
  for (const mod of ['../lib/scan', '../lib/aggregate', '../lib/rowstore']) delete require.cache[require.resolve(mod)];
  const aggregateModule = require('../lib/aggregate');
  let calls = 0;
  const realAggregate = aggregateModule.aggregate;
  // A spy on the real aggregate, not a fake result: the point is counting runs, and
  // the response still has to be the genuine output for the assertions to mean
  // anything. There is no seam to count runs through the HTTP API alone, since a memo
  // hit and a shared in-flight refresh return the same response shape.
  aggregateModule.aggregate = (...args) => {
    calls += 1;
    return realAggregate(...args);
  };
  delete require.cache[require.resolve('../server')];
  const server = require('../server');
  t.after(() => {
    aggregateModule.aggregate = realAggregate;
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
  assert.strictEqual(calls, 1, 'the second cold request shared the first refresh and its aggregate');
});

// A fixture with one session that starts on Sep 1 and one on Sep 10, and a
// changes.json marker on Sep 5 between them.
function startChangesServer(t, { changes, plugins } = {}) {
  const base = helpers.tmpDir(t, 'changes-api');
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
  helpers.withEnv(t, {
    CHANGES_FILE: changesPath,
    RTK_DB: path.join(base, 'no-rtk-here.db'),
    CLAUDE_CONFIG_DIR: base,
    PORT: '0',
  });
  for (const mod of ['../lib/scan', '../lib/aggregate', '../lib/rowstore', '../lib/changes', '../lib/efficiency', '../server']) delete require.cache[require.resolve(mod)];
  return { server: require('../server'), changesPath };
}

test('GET /api/changes returns sessions and before/after windows per marker', async (t) => {
  const { server } = startChangesServer(t, { changes: [{ date: '2026-09-05T12:00', kind: 'skill', label: 'a skill' }] });
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
  assert.deepStrictEqual(
    Object.keys(data.daily).sort(),
    ['bashMedian', 'bashP90', 'cacheHit', 'callsPerPrompt', 'costPerPrompt', 'sessionStart'],
    'no rtk database in the fixture, so no rtk series'
  );
  assert.deepStrictEqual(data.daily.sessionStart.map((d) => d.value), [40000, 50000]);
  assert.strictEqual(data.bashDaily, undefined, 'daily.bashMedian replaced it');
  assert.strictEqual(data.changesFile.status, 'ok');
});

test('GET /api/changes re-reads changes.json on every request', async (t) => {
  const { server, changesPath } = startChangesServer(t, { changes: [] });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/changes`;

  assert.strictEqual((await (await fetch(url)).json()).markers.length, 0);
  fs.writeFileSync(changesPath, JSON.stringify([{ date: '2026-09-05T12:00', kind: 'hook', label: 'new hook' }]));
  const second = await (await fetch(url)).json();
  assert.deepStrictEqual(second.markers.map((m) => m.label), ['new hook'], 'the scan is cached, the marker file is not');
});

test('GET /api/changes works with no marker sources at all', async (t) => {
  const { server } = startChangesServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/changes`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.markers, []);
  assert.strictEqual(data.changesFile.status, 'missing');
});

test('GET /api/limits sends only the limits', async (t) => {
  const server = startServer(t);
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
    today: null,
  });
});

test('GET /api/limits returns null when there is no usage cache', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/limits`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.json(), null);
});

test('GET /api/records returns the all-time busiest day', async (t) => {
  const server = startServer(t);
  const day = localDateStr(new Date());
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/records`);
  const data = await res.json();
  if (localDateStr(new Date()) !== day) return t.skip('crossed local midnight');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.allTime, { date: day, tokens: 1200, cost: 0.006 });
});

test('GET /api/records returns recentDays: the 6 days before today, not today', async (t) => {
  const server = startServer(t);
  const day = localDateStr(new Date());
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  // The fixture holds one line dated today. Add lines for 7, 6 and 1 days back.
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'demo');
  const lines = [7, 6, 1].map((back) => {
    const when = new Date();
    when.setHours(10, 0, 0, 0);
    when.setDate(when.getDate() - back);
    return JSON.stringify({
      timestamp: when.toISOString(),
      requestId: `req-back-${back}`,
      message: { id: `msg-back-${back}`, model: 'claude-sonnet-4-6-20260115', usage: { input_tokens: 1000, output_tokens: 200 } },
    });
  });
  fs.writeFileSync(path.join(dir, 'older.jsonl'), lines.join('\n') + '\n');

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/records`);
  const data = await res.json();
  if (localDateStr(new Date()) !== day) return t.skip('crossed local midnight');

  const dateBack = (back) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return localDateStr(d);
  };
  assert.strictEqual(res.status, 200);
  // The scan emits a zero entry for each empty day in the window.
  const byDate = Object.fromEntries(data.recentDays.map((d) => [d.date, d]));
  assert.deepStrictEqual(data.recentDays.map((d) => d.date), [6, 5, 4, 3, 2, 1].map(dateBack));
  assert.deepStrictEqual(byDate[dateBack(6)], { date: dateBack(6), tokens: 1200, cost: 0.006 });
  assert.deepStrictEqual(byDate[dateBack(1)], { date: dateBack(1), tokens: 1200, cost: 0.006 });
  assert.deepStrictEqual(byDate[dateBack(3)], { date: dateBack(3), tokens: 0, cost: 0 });
});

test('GET /api/records writes no records.json, and nothing in cc-dashboard/ but the transcript database', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  await fetch(`http://127.0.0.1:${server.address().port}/api/records`);

  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'cc-dashboard');
  assert.strictEqual(fs.existsSync(path.join(dir, 'records.json')), false);
  assert.ok(fs.readdirSync(dir).every((name) => name.startsWith('transcripts.db')), fs.readdirSync(dir).join(', '));
});

// A three-day-old transcript, old by content and by mtime so the row store persists it
// on the first refresh. It is an assistant line with a session id, so /api/changes lists
// it as a session too.
function writeStoredTranscript() {
  const when = new Date();
  when.setDate(when.getDate() - 3);
  when.setHours(10, 0, 0, 0);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'demo', 'old.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-old',
    timestamp: when.toISOString(),
    requestId: 'req-old',
    message: { id: 'msg-old', model: 'claude-sonnet-4-6-20260115', content: [], usage: { input_tokens: 5000, output_tokens: 0 } },
  }) + '\n');
  fs.utimesSync(file, when, when);
  return { file, when };
}

test('a transcript that is deleted after it was stored still counts in the All range, the record day and /api/changes', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { file, when } = writeStoredTranscript();

  const before = await (await fetch(`${base}/api/summary?days=all`)).json();
  assert.strictEqual(before.summary.totalInput, 6000);
  const changesBefore = await (await fetch(`${base}/api/changes`)).json();
  assert.ok(changesBefore.sessions.some((s) => s.context === 5000), 'the stored transcript is a session');
  assert.ok(
    changesBefore.changesFile.path.startsWith(process.env.CLAUDE_CONFIG_DIR),
    `changes.json path ${changesBefore.changesFile.path} is outside the test folder`,
  );
  assert.strictEqual(changesBefore.changesFile.status, 'missing');

  fs.unlinkSync(file);
  // /api/refresh clears the result memo, so the next request aggregates again
  // from whatever the row store holds instead of replaying an earlier result.
  assert.strictEqual((await fetch(`${base}/api/refresh`, { method: 'POST' })).status, 200);
  const after = await (await fetch(`${base}/api/summary?days=all`)).json();
  assert.strictEqual(after.summary.totalInput, 6000, 'the deleted transcript still counts');
  const changesAfter = await (await fetch(`${base}/api/changes`)).json();
  assert.deepStrictEqual(changesAfter.sessions, changesBefore.sessions, 'the deleted session is still listed');

  const records = await (await fetch(`${base}/api/records`)).json();
  assert.deepStrictEqual(records.allTime, { date: localDateStr(when), tokens: 5000, cost: 0.015 });
});

test('a transcript that is deleted while the server is stopped still counts after a restart', async (t) => {
  const first = startServer(t);
  await new Promise((resolve) => first.once('listening', resolve));
  const { file } = writeStoredTranscript();
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  assert.strictEqual((await (await fetch(`${firstBase}/api/summary?days=all`)).json()).summary.totalInput, 6000);
  first.close();

  fs.unlinkSync(file);
  for (const mod of ['../lib/scan', '../lib/aggregate', '../lib/rowstore', '../lib/store', '../server']) delete require.cache[require.resolve(mod)];
  const second = require('../server');
  t.after(() => second.close());
  await new Promise((resolve) => second.once('listening', resolve));

  const after = await (await fetch(`http://127.0.0.1:${second.address().port}/api/summary?days=all`)).json();
  assert.strictEqual(after.summary.totalInput, 6000, 'the database kept the deleted transcript across the restart');
});

test('a range is aggregated again after local midnight, although no transcript changed', async (t) => {
  // 23:59:50 local, so 20 s later the date has changed. The clock is mocked before the
  // first request, so the first result carries the old date.
  const late = new Date();
  late.setHours(23, 59, 50, 0);
  t.mock.timers.enable({ apis: ['Date'], now: late.getTime() });
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const first = await (await fetch(`${base}/api/summary?days=7`)).json();
  assert.strictEqual(first.daily[first.daily.length - 1].date, localDateStr(new Date()));

  // Day buckets run to today, so the last bucket moves when the date does.
  t.mock.timers.tick(20 * 1000);
  const second = await (await fetch(`${base}/api/summary?days=7`)).json();
  assert.strictEqual(second.daily[second.daily.length - 1].date, localDateStr(new Date()));
  assert.notStrictEqual(second.daily[second.daily.length - 1].date, first.daily[first.daily.length - 1].date);
});

test('the server still answers when the transcript database cannot be opened', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const warn = t.mock.method(console, 'warn', () => {});
  // SQLite cannot open a directory as a database. It is made after startServer and
  // before the first scan opens the database.
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'cc-dashboard', 'transcripts.db'), { recursive: true });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/summary?days=all`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).summary.totalInput, 1000);
  assert.ok(warn.mock.calls.some((c) => /Could not open/.test(c.arguments[0])));
});

test('GET /stats.js serves the shared statistics helpers', async (t) => {
  const server = startServer(t);
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
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = process.env.CLAUDE_CONFIG_DIR;
  appendCall(base, { sessionId: 'sess-a', id: 'a1', input: 700, output: 300 });
  // An Edit result: 1 line removed and 2 added, which the snapshot's 5 and 1 must not override.
  const editTime = new Date();
  editTime.setHours(10, 31, 0, 0);
  fs.appendFileSync(path.join(base, 'projects', 'demo', 'session.jsonl'), JSON.stringify({
    type: 'user',
    timestamp: editTime.toISOString(),
    sessionId: 'sess-a',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit1', content: 'ok' }] },
    toolUseResult: { filePath: '/a.js', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] },
  }) + '\n');
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
  assert.strictEqual(body.sessions[0].ended, null);
  assert.strictEqual(body.sessions[0].project, 'demo');
  assert.strictEqual('sessionId' in body.sessions[0], false);
  assert.ok(body.sessions[0].costTodayUsd > 0);
  assert.strictEqual(body.total.costTodayUsd, body.sessions[0].costTodayUsd);
  assert.strictEqual(body.total.costUsd, 0.42);
  assert.strictEqual('apiDurationMs' in body.total, false);
  assert.strictEqual('apiDurationMs' in body.sessions[0], false);
  // The lines come from the transcript's Edit result, not from the snapshot's 5 and 1.
  assert.strictEqual(body.total.linesAdded, 2);
  assert.strictEqual(body.total.linesRemoved, 1);
  assert.strictEqual(body.total.tokens, 1000);
  // appendCall wrote one call at 10:30 today, so the session has one one-call span.
  assert.strictEqual(body.sessions[0].spans.length, 1);
  assert.strictEqual(body.sessions[0].spans[0][0], body.sessions[0].spans[0][1]);
  assert.strictEqual(body.sessions[0].prompts, 0);
});

test('GET /api/sessions/live marks a session that ended', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  writeSnapshot(process.env.CLAUDE_CONFIG_DIR, {
    sessionId: 'sess-b', lastActiveAt: Date.now() - 60_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.1, durationMs: 60_000, apiDurationMs: 5_000, linesAdded: 0, linesRemoved: 0,
    endedAt: Date.now() - 30_000, endReason: 'clear',
  });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  const body = await res.json();
  assert.strictEqual(body.sessions[0].ended, 'clear');
  assert.strictEqual(body.sessions[0].live, false);
  assert.strictEqual('sessionId' in body.sessions[0], false);
});

test('GET /api/sessions/live joins the activity file of a session', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = process.env.CLAUDE_CONFIG_DIR;
  writeSnapshot(base, {
    sessionId: 'sess-c', lastActiveAt: Date.now() - 30_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.1, durationMs: 60_000, apiDurationMs: 5_000, linesAdded: 0, linesRemoved: 0,
  });
  const dir = path.join(base, 'cc-dashboard', 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'sess-c.json'), JSON.stringify({
    sessionId: 'sess-c', state: 'working', since: now - 5000,
    tool: { name: 'Bash', detail: 'npm test', startedAt: now - 3000 }, subagents: 2, updatedAt: now - 1000,
  }));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  const [row] = (await res.json()).sessions;
  assert.strictEqual(row.activity.state, 'working');
  assert.strictEqual(row.activity.tool.detail, 'npm test');
  assert.strictEqual(row.activity.subagents, 2);
  assert.strictEqual('sessionId' in row.activity, false);
});

test('GET /api/sessions/live gives null activity when there is no activity directory', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  writeSnapshot(process.env.CLAUDE_CONFIG_DIR, {
    sessionId: 'sess-d', lastActiveAt: Date.now() - 30_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.1, durationMs: 60_000, apiDurationMs: 5_000, linesAdded: 0, linesRemoved: 0,
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  assert.strictEqual((await res.json()).sessions[0].activity, null);
});

test('GET /api/sessions/live is empty with no snapshot directory', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    sessions: [],
    total: { costUsd: 0, costTodayUsd: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 },
  });
});

test('GET /api/sessions/live skips a corrupt snapshot and serves the rest', async (t) => {
  const server = startServer(t);
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
  const server = startServer(t);
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

test('GET /api/prices reports built-in prices when nothing was applied', async (t) => {
  const base = await listen(t);
  const source = await (await fetch(`${base}/api/prices`)).json();
  assert.strictEqual(source.kind, 'built-in');
  assert.strictEqual(source.date, '2026-09-28');
});

test('POST /api/prices/check returns the diff and changes nothing', async (t) => {
  stubPricingPage(t, PAGE);
  const base = await listen(t);
  const res = await post(`${base}/api/prices/check`);
  const diff = await res.json();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(diff.added.map((r) => r.match), ['sonnet-5-5']);
  assert.strictEqual(diff.unchanged, 18);
  assert.strictEqual((await (await fetch(`${base}/api/prices`)).json()).kind, 'built-in');
});

test('POST /api/prices/apply saves the check and re-prices the summary', async (t) => {
  stubPricingPage(t, withModelCells(PAGE, 'Claude Sonnet 4.6', ['$6 / MTok', '$7.50 / MTok', '$12 / MTok', '$0.60 / MTok', '$30 / MTok']));
  const base = await listen(t);
  const cost = async () => (await (await fetch(`${base}/api/summary?days=today`)).json()).summary.totalCost;
  // The fixture log is one claude-sonnet-4-6 request: 1000 input, 200 output.
  assert.ok(Math.abs((await cost()) - 0.006) < 1e-12);

  await post(`${base}/api/prices/check`);
  const today = localDateStr(new Date());
  const res = await post(`${base}/api/prices/apply`, { effectiveFrom: today });
  assert.strictEqual(res.status, 200);
  const source = await res.json();
  assert.strictEqual(source.kind, 'fetched');
  assert.strictEqual(source.date, today);
  assert.ok(Math.abs((await cost()) - 0.012) < 1e-12, 'the cached scan was dropped and re-priced');

  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'cc-dashboard', 'prices.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(saved.snapshots[0].rows.map((r) => r.match).sort(), ['sonnet-4-6', 'sonnet-5-5']);

  const again = await post(`${base}/api/prices/apply`, { effectiveFrom: today });
  assert.strictEqual(again.status, 409, 'a second Apply needs a new check');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).snapshots.length, 1);
});

test('POST /api/prices/apply refuses with no check, and refuses a future date', async (t) => {
  stubPricingPage(t, PAGE);
  const base = await listen(t);
  assert.strictEqual((await post(`${base}/api/prices/apply`, { effectiveFrom: '2026-09-01' })).status, 409);
  await post(`${base}/api/prices/check`);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const res = await post(`${base}/api/prices/apply`, { effectiveFrom: localDateStr(tomorrow) });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /future/);
  assert.strictEqual((await post(`${base}/api/prices/apply`, {})).status, 400, 'a missing date is refused');
});

test('POST /api/prices/check refuses a page that does not parse, and clears the pending check', async (t) => {
  stubPricingPage(t, PAGE);
  const base = await listen(t);
  await post(`${base}/api/prices/check`);
  globalThis.fetch = ((realFetch) => (url, opts) =>
    String(url).startsWith('https://') ? Promise.resolve(new Response('# nothing here')) : realFetch(url, opts))(globalThis.fetch);
  const res = await post(`${base}/api/prices/check`);
  assert.strictEqual(res.status, 422);
  assert.match((await res.json()).error, /prices are unchanged/);
  assert.strictEqual((await post(`${base}/api/prices/apply`, { effectiveFrom: localDateStr(new Date()) })).status, 409);
});

test('POST /api/prices/check reports a failed fetch as 502', async (t) => {
  stubPricingPage(t, 'unavailable', 503);
  const base = await listen(t);
  const res = await post(`${base}/api/prices/check`);
  assert.strictEqual(res.status, 502);
  assert.match((await res.json()).error, /503/);
});

test('the price POST routes refuse a cross-site request', async (t) => {
  stubPricingPage(t, PAGE);
  const base = await listen(t);
  for (const route of ['/api/prices/check', '/api/prices/apply']) {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.strictEqual(res.status, 403, route);
  }
});

test('GET /api/limits adds today\'s share of the weekly limit', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const now = Date.now();
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'rate-limits.json'), JSON.stringify({
    fetchedAtMs: now,
    rate_limits: { seven_day: { used_percentage: 17, resets_at: Math.floor(now / 1000) + 2 * 24 * 60 * 60 } },
    dayStart: { date: localDateStr(new Date(now)), percent: 13, from: 'previous-reading' },
  }));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/limits`);
  const body = await res.json();
  assert.strictEqual(body.source, 'statusline');
  assert.strictEqual(body.today.share, 4);
});

test('every GET /api route refuses a cross-site or same-site request', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const route of ['/api/summary?days=today', '/api/rtk?days=today', '/api/limits', '/api/sessions/live', '/api/prices']) {
    for (const site of ['cross-site', 'same-site']) {
      const res = await fetch(base + route, { headers: { 'Sec-Fetch-Site': site } });
      assert.strictEqual(res.status, 403, `${route} with Sec-Fetch-Site: ${site}`);
    }
  }
});

test('a GET /api request typed into the address bar is accepted', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/limits`, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.strictEqual(res.status, 200);
});

test('days accepts only the range picker values on /api/summary and /api/rtk', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const route of ['/api/summary', '/api/rtk']) {
    for (const days of ['5', '1000000000']) {
      const res = await fetch(`${base}${route}?days=${days}`);
      assert.strictEqual(res.status, 400, `${route}?days=${days}`);
      assert.match((await res.json()).error, /Invalid days/);
    }
    for (const days of ['7', '30', '90']) {
      assert.strictEqual((await fetch(`${base}${route}?days=${days}`)).status, 200, `${route}?days=${days}`);
    }
  }
});

test("the POST /api routes refuse Sec-Fetch-Site: none, which only a GET from the address bar sends", async (t) => {
  stubPricingPage(t, PAGE); // so a broken guard cannot reach platform.claude.com
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const route of ['/api/refresh', '/api/prices/check', '/api/prices/apply']) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Sec-Fetch-Site': 'none' } });
    assert.strictEqual(res.status, 403, route);
  }
});

test(
  'a session file the scan cannot read is logged once per range, not on every scan',
  { skip: process.getuid?.() === 0 && 'root can read a mode-000 file' },
  async (t) => {
    const server = startServer(t);
    t.after(() => server.close());
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const locked = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'demo', 'locked.jsonl');
    fs.writeFileSync(locked, '{}\n');
    fs.chmodSync(locked, 0o000);
    // No chmod back to 0o644: the folder is removed when the test ends, and unlinking a
    // mode-000 file only needs a writable directory.
    const warn = t.mock.method(console, 'warn', () => {});

    for (let i = 0; i < 2; i++) {
      await fetch(`${base}/api/refresh`, { method: 'POST' }); // drop the cache so each pass scans
      assert.strictEqual((await fetch(`${base}/api/summary?days=today`)).status, 200);
    }

    const scanWarnings = warn.mock.calls.filter((call) => /^\[scan\]/.test(call.arguments[0]));
    assert.strictEqual(scanWarnings.length, 1);
    assert.match(scanWarnings[0].arguments[0], /1 session file could not be read/);
    assert.match(scanWarnings[0].arguments[0], /Today/);
  }
);

function openTestReviewDb() {
  const { openReviewDb } = require('../lib/review-db');
  return openReviewDb();
}

test('GET /api/reviews lists finished reviews with suggestion state and the home directory', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const db = openTestReviewDb();
  const now = Date.now();
  const add = (id, status, extra = {}) => db.prepare(
    'INSERT INTO reviews (session_id, project, ended_at, status, claimed_at, reviewed_at, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'demo', now - 60_000, status, now - 90_000, now, extra.skip ?? null);
  add('sess-a', 'done');
  db.prepare("INSERT INTO suggestions (session_id, idx, kind, text) VALUES ('sess-a', 0, 'token-waste', 'Read the file once.')").run();
  add('sess-b', 'skipped', { skip: 'under 3 prompts' });
  db.close();

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/reviews`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    home: os.homedir(),
    reviews: [{
      sessionId: 'sess-a', title: null, branch: null, transcript: null, project: 'demo', endedAt: now - 60_000, reviewedAt: now, status: 'done',
      suggestions: [{ idx: 0, kind: 'token-waste', text: 'Read the file once.', dismissedAt: null, reason: null }],
    }],
  });
});

test('GET /api/reviews answers an empty list before any review exists', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/reviews`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { home: os.homedir(), reviews: [] });
});

test('GET /api/reviews imports review files from an earlier version', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'cc-dashboard', 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'sess-old.json'), JSON.stringify({
    sessionId: 'sess-old', project: 'demo', endedAt: now - 1000, reviewedAt: now, status: 'done', suggestions: [{ kind: 'workflow', text: 'Plan first.' }],
  }));
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/reviews`)).json();
  assert.deepStrictEqual(body.reviews.map((r) => [r.sessionId, r.suggestions.map((s) => s.text)]), [['sess-old', ['Plan first.']]]);
});

test('GET /api/reviews answers 500 with the reason when transcripts.db cannot be opened, and recovers when it can', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'cc-dashboard', 'transcripts.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a database '.repeat(100));
  t.mock.method(console, 'error', () => {});
  const url = `http://127.0.0.1:${server.address().port}/api/reviews`;
  const res = await fetch(url);
  assert.strictEqual(res.status, 500);
  const body = await res.json();
  assert.strictEqual(body.error, 'Failed to read session reviews');
  assert.ok(body.detail);
  fs.rmSync(file);
  assert.strictEqual((await fetch(url)).status, 200);
});

// Seeds one finished review with two suggestions and returns the base URL.
async function reviewServer(t) {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const db = require('../lib/review-db').openReviewDb();
  const now = Date.now();
  for (const id of ['sess-a', 'sess-b']) {
    db.prepare("INSERT INTO reviews (session_id, project, ended_at, status, claimed_at, reviewed_at) VALUES (?, 'demo', ?, 'done', ?, ?)").run(id, now - 1000, now - 2000, now);
    db.prepare("INSERT INTO suggestions (session_id, idx, kind, text) VALUES (?, 0, 'workflow', 'one'), (?, 1, 'token-waste', 'two')").run(id, id);
  }
  db.close();
  return `http://127.0.0.1:${server.address().port}`;
}

const dismissUrl = (base, id, idx) => `${base}/api/reviews/${id}/suggestions/${idx}/dismiss`;
const postJson = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const suggestionState = async (base, id) => (await (await fetch(`${base}/api/reviews`)).json()).reviews.find((r) => r.sessionId === id).suggestions.map((s) => s.reason);

test('POST dismiss stores the reason and GET /api/reviews shows it, DELETE undoes it', async (t) => {
  const base = await reviewServer(t);
  const res = await postJson(dismissUrl(base, 'sess-a', 1), { reason: 'not_useful' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual([body.ok, body.sessionId, body.idx, body.reason, typeof body.dismissedAt], [true, 'sess-a', 1, 'not_useful', 'number']);
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), [null, 'not_useful']);
  assert.deepStrictEqual(await suggestionState(base, 'sess-b'), [null, null]);

  const undo = await fetch(dismissUrl(base, 'sess-a', 1), { method: 'DELETE' });
  assert.strictEqual(undo.status, 200);
  assert.deepStrictEqual(await undo.json(), { ok: true, sessionId: 'sess-a', idx: 1, dismissedAt: null, reason: null });
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), [null, null]);
});

test('POST dismiss answers 400 for a bad reason, a missing body, bad json, a bad session id and a bad idx', async (t) => {
  const base = await reviewServer(t);
  for (const body of [{ reason: 'bored' }, {}, { reason: null }, { reason: ['done'] }]) {
    assert.strictEqual((await postJson(dismissUrl(base, 'sess-a', 0), body)).status, 400, JSON.stringify(body));
  }
  assert.strictEqual((await fetch(dismissUrl(base, 'sess-a', 0), { method: 'POST' })).status, 400);
  const badJson = await fetch(dismissUrl(base, 'sess-a', 0), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.strictEqual(badJson.status, 400);
  for (const idx of ['-1', '1.5', 'abc', '01x', '99999999999999999999']) {
    assert.strictEqual((await postJson(dismissUrl(base, 'sess-a', idx), { reason: 'done' })).status, 400, `idx ${idx}`);
    assert.strictEqual((await fetch(dismissUrl(base, 'sess-a', idx), { method: 'DELETE' })).status, 400, `DELETE idx ${idx}`);
  }
  assert.strictEqual((await postJson(dismissUrl(base, 'bad.id', 0), { reason: 'done' })).status, 400);
  assert.strictEqual((await postJson(dismissUrl(base, 'a'.repeat(129), 0), { reason: 'done' })).status, 400);
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), [null, null]);
});

test('POST and DELETE dismiss answer 404 for a session or an idx that does not exist', async (t) => {
  const base = await reviewServer(t);
  for (const [id, idx] of [['sess-a', 2], ['sess-zzz', 0], ['sess-a', 1000]]) {
    assert.strictEqual((await postJson(dismissUrl(base, id, idx), { reason: 'done' })).status, 404, `${id} ${idx}`);
    assert.strictEqual((await fetch(dismissUrl(base, id, idx), { method: 'DELETE' })).status, 404, `DELETE ${id} ${idx}`);
  }
});

test('the dismiss routes refuse a cross-site request, like the price POST routes', async (t) => {
  const base = await reviewServer(t);
  for (const site of ['cross-site', 'same-site', 'none']) {
    const post = await postJson(dismissUrl(base, 'sess-a', 0), { reason: 'done' }, { 'Sec-Fetch-Site': site });
    assert.strictEqual(post.status, 403, `POST ${site}`);
    const del = await fetch(dismissUrl(base, 'sess-a', 0), { method: 'DELETE', headers: { 'Sec-Fetch-Site': site } });
    assert.strictEqual(del.status, 403, `DELETE ${site}`);
  }
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), [null, null]);
  const ok = await postJson(dismissUrl(base, 'sess-a', 0), { reason: 'done' }, { 'Sec-Fetch-Site': 'same-origin' });
  assert.strictEqual(ok.status, 200);
});

test('the dismiss routes answer 500 with the reason when transcripts.db cannot be opened', async (t) => {
  const server = startServer(t);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'cc-dashboard', 'transcripts.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a database '.repeat(100));
  t.mock.method(console, 'error', () => {});
  const res = await postJson(dismissUrl(`http://127.0.0.1:${server.address().port}`, 'sess-a', 0), { reason: 'done' });
  assert.strictEqual(res.status, 500);
  assert.ok((await res.json()).detail);
});
