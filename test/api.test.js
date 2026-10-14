'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { localDateStr } = require('../lib/dates');
const { openDatabase, getStorePath } = require('../lib/db');

// Boots the server on a config whose projects/demo holds one Sonnet call at 10:00
// today. Resolves to { server, config, port, url }.
async function startServer(t) {
  const config = helpers.testConfig(t, 'api');
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
  fs.writeFileSync(path.join(config.configDir, 'projects', 'demo', 'session.jsonl'), line + '\n');
  return helpers.bootServer(t, config);
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

async function listen(t) { return (await startServer(t)).url; }

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('createServer returns a server that is not listening yet', (t) => {
  const { createServer } = require('../server');
  const server = createServer(helpers.testConfig(t, 'factory'));
  assert.strictEqual(server.listening, false);
  t.after(() => server.emit('close'));
});

test('warmUp starts the first read of the transcripts before any request', async (t) => {
  const { createServer } = require('../server');
  const config = helpers.testConfig(t, 'warm');
  fs.writeFileSync(path.join(config.configDir, 'projects', 'demo', 'session.jsonl'), JSON.stringify({
    timestamp: new Date().toISOString(),
    requestId: 'req-1',
    message: { id: 'msg-1', model: 'claude-sonnet-4-6-20260115', usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n');
  const log = t.mock.method(console, 'log', () => {});
  const server = createServer(config);
  t.after(() => server.emit('close'));

  server.warmUp();

  const logged = () => log.mock.calls.some((c) => /^\[rows\] Read 1 of 1 transcripts/.test(String(c.arguments[0])));
  for (let i = 0; i < 100 && !logged(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(logged(), 'the row store read the transcript with no request made');
});

test('two servers in one process each read their own config folder', async (t) => {
  const one = helpers.testConfig(t, 'one');
  const two = helpers.testConfig(t, 'two');
  const call = (input) => JSON.stringify({
    timestamp: new Date().toISOString(),
    requestId: `req-${input}`,
    message: { id: `msg-${input}`, model: 'claude-sonnet-4-6-20260115', usage: { input_tokens: input, output_tokens: 1 } },
  }) + '\n';
  fs.writeFileSync(path.join(one.configDir, 'projects', 'demo', 'a.jsonl'), call(111));
  fs.writeFileSync(path.join(two.configDir, 'projects', 'demo', 'a.jsonl'), call(222));
  const [a, b] = await Promise.all([helpers.bootServer(t, one), helpers.bootServer(t, two)]);
  const [sa, sb] = await Promise.all([a, b].map(async (s) => (await fetch(`${s.url}/api/summary?days=all`)).json()));
  assert.strictEqual(sa.summary.totalInput, 111);
  assert.strictEqual(sb.summary.totalInput, 222);
  assert.ok(fs.existsSync(path.join(one.configDir, 'cc-dashboard', 'transcripts.db')));
  assert.ok(fs.existsSync(path.join(two.configDir, 'cc-dashboard', 'transcripts.db')));
});

test('GET /api/summary?days=today returns one bucket per local hour', async (t) => {
  const { url } = await startServer(t);
  const res = await fetch(`${url}/api/summary?days=today`);
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
  const { url, config } = await startServer(t);
  const first = await (await fetch(`${url}/api/summary?days=today`)).json();
  assert.strictEqual(first.summary.totalOutput, 200);

  // Append a second entry, then request again with no /api/refresh call in between.
  const dir = path.join(config.configDir, 'projects', 'demo');
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
  const second = await (await fetch(`${url}/api/summary?days=today`)).json();
  assert.strictEqual(second.summary.totalOutput, 500, 'the new entry appears without a manual refresh');
});

test('GET /api/summary rejects a days value it cannot honour', async (t) => {
  const { url } = await startServer(t);
  const get = (qs) => fetch(`${url}/api/summary${qs}`);

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
  const { url: base } = await startServer(t);
  const url = `${base}/api/refresh`;

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
  const { url } = await startServer(t);

  const res = await fetch(`${url}/api/rtk?days=30`);
  const data = await res.json();

  assert.strictEqual(res.status, 200, 'a missing rtk database is not an error');
  assert.strictEqual(data.meta.dbExists, false);
  assert.deepStrictEqual(data.daily, []);
  assert.strictEqual(data.summary.totalCommands, 0);
});

test('GET /api/rtk rejects a malformed days value the same way /api/summary does', async (t) => {
  const { url } = await startServer(t);

  const res = await fetch(`${url}/api/rtk?days=-3`);
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Invalid days/);
});

test('GET /api/rtk?days=today buckets by hour', async (t) => {
  const { url } = await startServer(t);

  const res = await fetch(`${url}/api/rtk?days=today`);
  const data = await res.json();
  assert.strictEqual(res.status, 200);
  // No fixture rows, so the assertion is on shape, not content.
  assert.ok(Array.isArray(data.daily));
});

test('GET /api/summary does not send the per-call efficiency records', async (t) => {
  const { url } = await startServer(t);

  for (const days of ['today', '30']) {
    const data = await (await fetch(`${url}/api/summary?days=${days}`)).json();
    assert.strictEqual(data.efficiency, undefined, `days=${days} must not include efficiency`);
  }
});

// A fixture with sessions that start on Aug 28, Sep 5 and Sep 12, and a changes.json
// marker on Sep 9, 12 days after the first call so the first-week rule keeps it.
async function startChangesServer(t, { changes, plugins } = {}) {
  const config = helpers.testConfig(t, 'changes-api');
  const base = config.configDir;
  const dir = path.join(base, 'projects', 'demo');
  const line = (iso, id, sessionId, context) => JSON.stringify({
    type: 'assistant', timestamp: iso, sessionId, requestId: 'req-' + id,
    message: { id: 'msg-' + id, model: 'claude-opus-5', content: [], usage: { input_tokens: context, output_tokens: 10 } },
  });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [
    line('2026-08-28T15:00:00Z', 'z', 's0', 30000),
    line('2026-09-05T15:00:00Z', 'a', 's1', 40000),
    line('2026-09-12T15:00:00Z', 'b', 's2', 50000),
  ].join('\n') + '\n');
  if (plugins) {
    fs.mkdirSync(path.join(base, 'plugins'));
    fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'), JSON.stringify(plugins));
  }
  if (changes) fs.writeFileSync(config.changesFile, JSON.stringify(changes));
  return { ...(await helpers.bootServer(t, config)), changesPath: config.changesFile };
}

test('GET /api/changes returns sessions and before/after windows per marker', async (t) => {
  const { url } = await startChangesServer(t, { changes: [{ date: '2026-09-09T12:00', kind: 'skill', label: 'a skill' }] });
  const res = await fetch(`${url}/api/changes`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.sessions.map((s) => s.context), [30000, 40000, 50000]);
  assert.strictEqual(data.markers.length, 1);
  const m = data.markers[0];
  assert.strictEqual(m.label, 'a skill');
  assert.strictEqual(m.before.sessionStart, 40000);
  assert.strictEqual(m.after.sessionStart, 50000);
  assert.strictEqual(m.before.rtk, null, 'no rtk database in the fixture');
  assert.deepStrictEqual(
    Object.keys(data.daily).sort(),
    ['bashMedian', 'bashP90', 'cacheHit', 'callsPerPrompt', 'costPerPrompt', 'sessionStart', 'thinkingShare'],
    'no rtk database in the fixture, so no rtk series'
  );
  assert.deepStrictEqual(data.daily.sessionStart.map((d) => d.value), [30000, 40000, 50000]);
  assert.strictEqual(data.bashDaily, undefined, 'daily.bashMedian replaced it');
  assert.strictEqual(data.changesFile.status, 'ok');
});

test('GET /api/changes re-reads changes.json on every request', async (t) => {
  const { url: base, changesPath } = await startChangesServer(t, { changes: [] });
  const url = `${base}/api/changes`;

  assert.strictEqual((await (await fetch(url)).json()).markers.length, 0);
  fs.writeFileSync(changesPath, JSON.stringify([{ date: '2026-09-09T12:00', kind: 'hook', label: 'new hook' }]));
  const second = await (await fetch(url)).json();
  assert.deepStrictEqual(second.markers.map((m) => m.label), ['new hook'], 'the scan is cached, the marker file is not');
});

test('GET /api/changes works with no marker sources at all', async (t) => {
  const { url } = await startChangesServer(t);
  const res = await fetch(`${url}/api/changes`);
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.markers, []);
  assert.strictEqual(data.changesFile.status, 'missing');
});

test('GET /api/limits sends only the limits', async (t) => {
  const { url, config } = await startServer(t);

  const resets = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(config.configDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'someone@example.com' },
    cachedUsageUtilization: {
      fetchedAtMs: 123,
      accountUuid: 'acct-1',
      utilization: { five_hour: { utilization: 6, resets_at: resets, used_dollars: null } },
    },
  }));

  const res = await fetch(`${url}/api/limits`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    fetchedAt: 123,
    limits: [{ key: 'five_hour', label: 'Current session', percent: 6, resetsAt: Date.parse(resets) }],
    source: 'usage-cache',
    today: null,
  });
});

test('GET /api/limits returns null when there is no usage cache', async (t) => {
  const { url } = await startServer(t);

  const res = await fetch(`${url}/api/limits`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.json(), null);
});

test('GET /api/records returns the all-time busiest day', async (t) => {
  const { url } = await startServer(t);
  const day = localDateStr(new Date());

  const res = await fetch(`${url}/api/records`);
  const data = await res.json();
  if (localDateStr(new Date()) !== day) return t.skip('crossed local midnight');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(data.allTime, { date: day, tokens: 1200, cost: 0.006 });
});

test('GET /api/records returns recentDays: the 6 days before today, not today', async (t) => {
  const { url, config } = await startServer(t);
  const day = localDateStr(new Date());

  // The fixture holds one line dated today. Add lines for 7, 6 and 1 days back.
  const dir = path.join(config.configDir, 'projects', 'demo');
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

  const res = await fetch(`${url}/api/records`);
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
  const { url, config } = await startServer(t);

  await fetch(`${url}/api/records`);

  const dir = path.join(config.configDir, 'cc-dashboard');
  assert.strictEqual(fs.existsSync(path.join(dir, 'records.json')), false);
  assert.ok(fs.readdirSync(dir).every((name) => name.startsWith('transcripts.db')), fs.readdirSync(dir).join(', '));
});

// A three-day-old transcript, old by content and by mtime so the row store persists it
// on the first refresh. It is an assistant line with a session id, so /api/changes lists
// it as a session too.
function writeStoredTranscript(config) {
  const when = new Date();
  when.setDate(when.getDate() - 3);
  when.setHours(10, 0, 0, 0);
  const file = path.join(config.configDir, 'projects', 'demo', 'old.jsonl');
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
  const { url: base, config } = await startServer(t);
  const { file, when } = writeStoredTranscript(config);

  const before = await (await fetch(`${base}/api/summary?days=all`)).json();
  assert.strictEqual(before.summary.totalInput, 6000);
  const changesBefore = await (await fetch(`${base}/api/changes`)).json();
  assert.ok(changesBefore.sessions.some((s) => s.context === 5000), 'the stored transcript is a session');
  assert.ok(
    changesBefore.changesFile.path.startsWith(config.configDir),
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
  const first = await startServer(t);
  const { file } = writeStoredTranscript(first.config);
  assert.strictEqual((await (await fetch(`${first.url}/api/summary?days=all`)).json()).summary.totalInput, 6000);
  await new Promise((resolve) => first.server.close(resolve));
  // Closing the first server closes its transcripts.db handle, so the second server opens the file from disk, which is what a restart does.

  fs.unlinkSync(file);
  const second = await helpers.bootServer(t, first.config);
  const after = await (await fetch(`${second.url}/api/summary?days=all`)).json();
  assert.strictEqual(after.summary.totalInput, 6000, 'the database kept the deleted transcript across the restart');
});

test('a range is aggregated again after local midnight, although no transcript changed', async (t) => {
  // 23:59:50 local, so 20 s later the date has changed. The clock is mocked before the
  // first request, so the first result carries the old date.
  const late = new Date();
  late.setHours(23, 59, 50, 0);
  t.mock.timers.enable({ apis: ['Date'], now: late.getTime() });
  const { url: base } = await startServer(t);

  const first = await (await fetch(`${base}/api/summary?days=7`)).json();
  assert.strictEqual(first.daily[first.daily.length - 1].date, localDateStr(new Date()));

  // Day buckets run to today, so the last bucket moves when the date does.
  t.mock.timers.tick(20 * 1000);
  const second = await (await fetch(`${base}/api/summary?days=7`)).json();
  assert.strictEqual(second.daily[second.daily.length - 1].date, localDateStr(new Date()));
  assert.notStrictEqual(second.daily[second.daily.length - 1].date, first.daily[first.daily.length - 1].date);
});

test('the server still answers when the transcript database cannot be opened', async (t) => {
  const { url, config } = await startServer(t);
  const warn = t.mock.method(console, 'warn', () => {});
  // SQLite cannot open a directory as a database. It is made after startServer and
  // before the first scan opens the database.
  fs.mkdirSync(path.join(config.configDir, 'cc-dashboard', 'transcripts.db'), { recursive: true });

  const res = await fetch(`${url}/api/summary?days=all`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).summary.totalInput, 1000);
  assert.ok(warn.mock.calls.some((c) => /Could not open/.test(c.arguments[0])));
});

test('GET /stats.js serves the shared statistics helpers', async (t) => {
  const { url } = await startServer(t);

  const res = await fetch(`${url}/stats.js`);
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
  const { url, config } = await startServer(t);
  const base = config.configDir;
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

  const res = await fetch(`${url}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.sessions.length, 1);
  assert.strictEqual(body.sessions[0].tokens, 1000);
  assert.strictEqual(body.sessions[0].live, true);
  assert.strictEqual(body.sessions[0].ended, null);
  assert.strictEqual(body.sessions[0].project, 'demo');
  assert.strictEqual(body.sessions[0].sessionId, 'sess-a');
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
  const { url, config } = await startServer(t);
  writeSnapshot(config.configDir, {
    sessionId: 'sess-b', lastActiveAt: Date.now() - 60_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.1, durationMs: 60_000, apiDurationMs: 5_000, linesAdded: 0, linesRemoved: 0,
    endedAt: Date.now() - 30_000, endReason: 'clear',
  });

  const res = await fetch(`${url}/api/sessions/live`);
  const body = await res.json();
  assert.strictEqual(body.sessions[0].ended, 'clear');
  assert.strictEqual(body.sessions[0].live, false);
  assert.strictEqual(body.sessions[0].sessionId, 'sess-b');
});

test('GET /api/sessions/live joins the activity file of a session', async (t) => {
  const { url, config } = await startServer(t);
  const base = config.configDir;
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

  const res = await fetch(`${url}/api/sessions/live`);
  const [row] = (await res.json()).sessions;
  assert.strictEqual(row.activity.state, 'working');
  assert.strictEqual(row.activity.tool.detail, 'npm test');
  assert.strictEqual(row.activity.subagents, 2);
  assert.strictEqual('sessionId' in row.activity, false);
});

test('GET /api/sessions/live gives a waiting session the 1-hour cache a write before today set', async (t) => {
  const { url, config } = await startServer(t);
  const base = config.configDir;
  const now = Date.now();
  const line = (t, id, usage) => JSON.stringify({
    timestamp: new Date(t).toISOString(), requestId: `req-${id}`, sessionId: 'sess-w',
    message: { id: `msg-${id}`, model: 'claude-sonnet-4-6-20260115', usage },
  }) + '\n';
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(base, 'projects', 'demo', 'sess-w.jsonl'),
    line(now - 3 * 86_400_000, 'w1', { input_tokens: 10, output_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 5000 } })
    + line(now - 60_000, 'w2', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 5000 }));
  writeSnapshot(base, {
    sessionId: 'sess-w', lastActiveAt: now - 60_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.1, durationMs: 60_000, apiDurationMs: 5_000, linesAdded: 0, linesRemoved: 0,
  });
  const dir = path.join(base, 'cc-dashboard', 'activity');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-w.json'), JSON.stringify({
    sessionId: 'sess-w', state: 'waiting', since: now - 30_000, tool: null, subagents: 0, updatedAt: now - 1000,
  }));

  const [row] = (await (await fetch(`${url}/api/sessions/live`)).json()).sessions;
  assert.strictEqual(row.cache.ttl, '1h');
});

test('GET /api/sessions/live gives null activity when there is no activity directory', async (t) => {
  const { url, config } = await startServer(t);
  writeSnapshot(config.configDir, {
    sessionId: 'sess-d', lastActiveAt: Date.now() - 30_000, project: 'demo', model: 'Sonnet 4.6',
    costUsd: 0.1, durationMs: 60_000, apiDurationMs: 5_000, linesAdded: 0, linesRemoved: 0,
  });
  const res = await fetch(`${url}/api/sessions/live`);
  assert.strictEqual((await res.json()).sessions[0].activity, null);
});

test('GET /api/sessions/live is empty with no snapshot directory', async (t) => {
  const { url } = await startServer(t);
  const res = await fetch(`${url}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    sessions: [],
    total: { costUsd: 0, costTodayUsd: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 },
  });
});

test('GET /api/sessions/live skips a corrupt snapshot and serves the rest', async (t) => {
  const { url, config } = await startServer(t);
  const base = config.configDir;
  const dir = writeSnapshot(base, {
    sessionId: 'ok', lastActiveAt: Date.now() - 1000, project: 'demo', model: null,
    costUsd: 1, durationMs: 1, apiDurationMs: 1, linesAdded: 0, linesRemoved: 0,
  });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"sessionId":');
  const res = await fetch(`${url}/api/sessions/live`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).sessions.length, 1);
});

test('the Today scan is shared between /api/summary and /api/sessions/live', async (t) => {
  const { url, config } = await startServer(t);
  const base = config.configDir;
  writeSnapshot(base, {
    sessionId: 'sess-b', lastActiveAt: Date.now() - 1000, project: 'demo', model: null,
    costUsd: 1, durationMs: 1, apiDurationMs: 1, linesAdded: 0, linesRemoved: 0,
  });
  // Requested together, the way loadAndRender sends them.
  const [summary] = await Promise.all([
    fetch(`${url}/api/summary?days=today`).then((r) => r.json()),
    fetch(`${url}/api/sessions/live`).then((r) => r.json()),
  ]);
  // A line appended right after is not in a scan shared within 2 seconds...
  appendCall(base, { sessionId: 'sess-b', id: 'b1', input: 10, output: 0 });
  const live = await (await fetch(`${url}/api/sessions/live`)).json();
  assert.strictEqual(live.sessions[0].tokens, 0);
  assert.strictEqual(summary.summary.totalOutput, 200);
  // ...and is after the share window, which a 5s live poll always is.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const later = await (await fetch(`${url}/api/sessions/live`)).json();
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
  const { url: base, config } = await startServer(t);
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

  const file = path.join(config.configDir, 'cc-dashboard', 'prices.json');
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
  const { url, config } = await startServer(t);

  const now = Date.now();
  fs.writeFileSync(path.join(config.configDir, 'rate-limits.json'), JSON.stringify({
    fetchedAtMs: now,
    rate_limits: { seven_day: { used_percentage: 17, resets_at: Math.floor(now / 1000) + 2 * 24 * 60 * 60 } },
    dayStart: { date: localDateStr(new Date(now)), percent: 13, from: 'previous-reading' },
  }));

  const res = await fetch(`${url}/api/limits`);
  const body = await res.json();
  assert.strictEqual(body.source, 'statusline');
  assert.strictEqual(body.today.share, 4);
});

test('every GET /api route refuses a cross-site or same-site request', async (t) => {
  const { url: base } = await startServer(t);

  for (const route of ['/api/summary?days=today', '/api/rtk?days=today', '/api/limits', '/api/sessions/live', '/api/prices']) {
    for (const site of ['cross-site', 'same-site']) {
      const res = await fetch(base + route, { headers: { 'Sec-Fetch-Site': site } });
      assert.strictEqual(res.status, 403, `${route} with Sec-Fetch-Site: ${site}`);
    }
  }
});

test('a GET /api request typed into the address bar is accepted', async (t) => {
  const { url } = await startServer(t);

  const res = await fetch(`${url}/api/limits`, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.strictEqual(res.status, 200);
});

test('days accepts only the range picker values on /api/summary and /api/rtk', async (t) => {
  const { url: base } = await startServer(t);

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

test('the summary and rtk routes send no X-Powered-By header', async (t) => {
  const base = await listen(t);
  for (const route of ['/api/summary?days=7', '/api/rtk?days=7']) {
    const res = await fetch(`${base}${route}`);
    assert.strictEqual(res.status, 200, route);
    assert.strictEqual(res.headers.get('x-powered-by'), null, route);
  }
});

test('an empty days query reads the 30-day range on both routes', async (t) => {
  const base = await listen(t);
  for (const route of ['/api/summary', '/api/rtk']) {
    const empty = await (await fetch(`${base}${route}?days=`)).json();
    const thirty = await (await fetch(`${base}${route}?days=30`)).json();
    assert.deepStrictEqual(empty, thirty, route);
  }
});

test("the POST /api routes refuse Sec-Fetch-Site: none, which only a GET from the address bar sends", async (t) => {
  stubPricingPage(t, PAGE); // so a broken guard cannot reach platform.claude.com
  const { url: base } = await startServer(t);

  for (const route of ['/api/refresh', '/api/prices/check', '/api/prices/apply']) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Sec-Fetch-Site': 'none' } });
    assert.strictEqual(res.status, 403, route);
  }
});

test(
  'a session file the scan cannot read is logged once per range, not on every scan',
  { skip: process.getuid?.() === 0 && 'root can read a mode-000 file' },
  async (t) => {
    const { url: base, config } = await startServer(t);
    const locked = path.join(config.configDir, 'projects', 'demo', 'locked.jsonl');
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

function openTestReviewDb(config) {
  const { openReviewDb, legacyReviewsDir } = require('../lib/review-db');
  return openReviewDb(getStorePath(config.configDir), legacyReviewsDir(config.configDir));
}

test('GET /api/reviews lists finished reviews with suggestion state', async (t) => {
  const { url, config } = await startServer(t);
  const db = openTestReviewDb(config);
  const now = Date.now();
  const add = (id, status, extra = {}) => db.prepare(
    'INSERT INTO reviews (session_id, project, ended_at, status, claimed_at, reviewed_at, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'demo', now - 60_000, status, now - 90_000, now, extra.skip ?? null);
  add('sess-a', 'done');
  db.prepare("INSERT INTO suggestions (session_id, idx, kind, text) VALUES ('sess-a', 0, 'token-waste', 'Read the file once.')").run();
  add('sess-b', 'skipped', { skip: 'under 3 prompts' });
  db.close();

  const res = await fetch(`${url}/api/reviews`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    reviews: [{
      sessionId: 'sess-a', title: null, branch: null, transcript: null, project: 'demo', endedAt: now - 60_000, reviewedAt: now, status: 'done',
      suggestions: [{ idx: 0, kind: 'token-waste', text: 'Read the file once.', dismissedAt: null, reason: null }],
    }],
  });
});

test('GET /api/reviews answers an empty list before any review exists', async (t) => {
  const { url } = await startServer(t);
  const res = await fetch(`${url}/api/reviews`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { reviews: [] });
});

test('GET /api/reviews imports review files from an earlier version', async (t) => {
  const { url, config } = await startServer(t);
  const dir = path.join(config.configDir, 'cc-dashboard', 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'sess-old.json'), JSON.stringify({
    sessionId: 'sess-old', project: 'demo', endedAt: now - 1000, reviewedAt: now, status: 'done', suggestions: [{ kind: 'workflow', text: 'Plan first.' }],
  }));
  const body = await (await fetch(`${url}/api/reviews`)).json();
  assert.deepStrictEqual(body.reviews.map((r) => [r.sessionId, r.suggestions.map((s) => s.text)]), [['sess-old', ['Plan first.']]]);
});

test('GET /api/reviews answers 500 with the reason when transcripts.db cannot be opened, and recovers when it can', async (t) => {
  const { url: base, config } = await startServer(t);
  const file = path.join(config.configDir, 'cc-dashboard', 'transcripts.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a database '.repeat(100));
  t.mock.method(console, 'error', () => {});
  const url = `${base}/api/reviews`;
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
  const { url, config } = await startServer(t);
  const db = openTestReviewDb(config);
  const now = Date.now();
  for (const id of ['sess-a', 'sess-b']) {
    db.prepare("INSERT INTO reviews (session_id, project, ended_at, status, claimed_at, reviewed_at) VALUES (?, 'demo', ?, 'done', ?, ?)").run(id, now - 1000, now - 2000, now);
    db.prepare("INSERT INTO suggestions (session_id, idx, kind, text) VALUES (?, 0, 'workflow', 'one'), (?, 1, 'token-waste', 'two')").run(id, id);
  }
  db.close();
  return { base: url, config };
}

const dismissUrl = (base, id, idx) => `${base}/api/reviews/${id}/suggestions/${idx}/dismiss`;
const postJson = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const suggestionState = async (base, id) => (await (await fetch(`${base}/api/reviews`)).json()).reviews.find((r) => r.sessionId === id).suggestions.map((s) => s.reason);

test('POST dismiss stores the reason and GET /api/reviews shows it, DELETE undoes it', async (t) => {
  const { base } = await reviewServer(t);
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

test('POST dismiss accepts duplicate and names all three reasons in its 400 answer', async (t) => {
  const { base } = await reviewServer(t);
  const ok = await postJson(dismissUrl(base, 'sess-a', 0), { reason: 'duplicate' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), ['duplicate', null]);
  const bad = await postJson(dismissUrl(base, 'sess-a', 0), { reason: 'bored' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await bad.json()).error, 'reason must be "done", "not_useful" or "duplicate".');
});

test('POST dismiss answers 400 for a bad reason, a missing body, bad json, a bad session id and a bad idx', async (t) => {
  const { base } = await reviewServer(t);
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
  const { base } = await reviewServer(t);
  for (const [id, idx] of [['sess-a', 2], ['sess-zzz', 0], ['sess-a', 1000]]) {
    assert.strictEqual((await postJson(dismissUrl(base, id, idx), { reason: 'done' })).status, 404, `${id} ${idx}`);
    assert.strictEqual((await fetch(dismissUrl(base, id, idx), { method: 'DELETE' })).status, 404, `DELETE ${id} ${idx}`);
  }
});

test('the dismiss routes refuse a cross-site request, like the price POST routes', async (t) => {
  const { base } = await reviewServer(t);
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
  const { url, config } = await startServer(t);
  const file = path.join(config.configDir, 'cc-dashboard', 'transcripts.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a database '.repeat(100));
  t.mock.method(console, 'error', () => {});
  const res = await postJson(dismissUrl(url, 'sess-a', 0), { reason: 'done' });
  assert.strictEqual(res.status, 500);
  assert.ok((await res.json()).detail);
});

// A server whose transcripts.db exists in WAL mode before any request, so a child
// process can hold its write lock (holdWriteLock in test/helpers.js).
async function lockableServer(t) {
  const { url: base, config } = await startServer(t);
  const file = getStorePath(config.configDir);
  openDatabase(file).close();
  return { base, config, file };
}

test('a request whose row-store write meets the review lock answers 200 within 1000 ms', async (t) => {
  const { base, config, file } = await lockableServer(t);
  writeStoredTranscript(config); // three days old, so the first refresh writes it
  const release = await helpers.holdWriteLock(t, file);
  const warn = t.mock.method(console, 'warn', () => {});
  const started = Date.now();
  const res = await fetch(`${base}/api/summary?days=7`);
  const took = Date.now() - started;
  const body = await res.json();
  await release();
  assert.strictEqual(res.status, 200);
  assert.ok(took < 1000, `answered in ${took} ms`);
  assert.strictEqual(body.summary.totalInput, 6000);
  assert.ok(warn.mock.calls.some((c) => /\(database busy\)/.test(c.arguments[0])), 'the write met the lock');
});

const BUSY = { error: 'The review database is busy. Try again.' };

test('GET /api/reviews answers 503 within 1000 ms when its first import meets the review lock, and 200 once the lock is gone', async (t) => {
  const { base, file } = await lockableServer(t);
  const release = await helpers.holdWriteLock(t, file);
  const started = Date.now();
  const res = await fetch(`${base}/api/reviews`);
  const took = Date.now() - started;
  assert.strictEqual(res.status, 503);
  assert.deepStrictEqual(await res.json(), BUSY);
  assert.ok(took < 1000, `answered in ${took} ms`);
  await release();
  const after = await fetch(`${base}/api/reviews`);
  assert.strictEqual(after.status, 200);
  assert.deepStrictEqual(await after.json(), { reviews: [] });
});

test('the dismiss routes answer 503 within 1000 ms under the review lock, reads still answer, and a dismiss works after', async (t) => {
  const { base, config } = await reviewServer(t);
  assert.strictEqual((await fetch(`${base}/api/reviews`)).status, 200); // runs the import before the lock
  const release = await helpers.holdWriteLock(t, getStorePath(config.configDir));
  const sends = {
    POST: () => postJson(dismissUrl(base, 'sess-a', 0), { reason: 'done' }),
    DELETE: () => fetch(dismissUrl(base, 'sess-a', 0), { method: 'DELETE' }),
  };
  for (const [method, send] of Object.entries(sends)) {
    const started = Date.now();
    const res = await send();
    const took = Date.now() - started;
    assert.strictEqual(res.status, 503, method);
    assert.deepStrictEqual(await res.json(), BUSY, method);
    assert.ok(took < 1000, `${method} answered in ${took} ms`);
  }
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), [null, null], 'GET /api/reviews reads under the lock');
  await release();
  assert.strictEqual((await postJson(dismissUrl(base, 'sess-a', 0), { reason: 'done' })).status, 200);
  assert.deepStrictEqual(await suggestionState(base, 'sess-a'), ['done', null]);
});

test('a malformed JSON body on the dismiss and apply routes answers JSON 400, not an HTML page', async (t) => {
  const { url: base } = await startServer(t);
  for (const url of [dismissUrl(base, 'sess-a', 0), `${base}/api/prices/apply`]) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    assert.strictEqual(res.status, 400, url);
    assert.match(res.headers.get('content-type'), /application\/json/, url);
    assert.strictEqual(typeof (await res.json()).error, 'string', url);
  }
});
