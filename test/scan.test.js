'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scanUsage } = require('./scan-usage');
const { localDateStr } = require('../lib/dates');

// scanUsage takes its directory as projectsDir, so each
// test points it at a throwaway fixture tree: <tmp>/projects/<project>/<file>.jsonl
function makeFixture() {
  const base = helpers.tmpDir(null, 'test');
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  return base;
}

// One usage line in the shape extractFile expects (lib/extract.js).
function usageLine(isoTimestamp, { id, input = 100, output = 50 }) {
  return JSON.stringify({
    timestamp: isoTimestamp,
    requestId: 'req-' + id,
    message: {
      id: 'msg-' + id,
      model: 'claude-sonnet-4-6-20260115',
      usage: { input_tokens: input, output_tokens: output },
    },
  });
}

function writeSession(base, name, lines, mtimeMs) {
  const file = path.join(base, 'projects', 'demo', name + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (mtimeMs != null) {
    const seconds = mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return file;
}

function atHourToday(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Each test reads its own fixture folder, passed in as projectsDir.
function loadScan(base) {
  const projectsDir = path.join(base, 'projects');
  return { scanUsage: (opts = {}) => scanUsage({ ...opts, projectsDir }), localDateStr };
}

test("days: 'today' includes entries after local midnight and excludes yesterday", async () => {
  const base = makeFixture();
  const todayNoon = atHourToday(12);
  const yesterdayNoon = new Date(todayNoon.getTime() - 24 * 60 * 60 * 1000);

  writeSession(base, 'today', [usageLine(todayNoon.toISOString(), { id: 'a', input: 300 })]);
  writeSession(base, 'yesterday', [usageLine(yesterdayNoon.toISOString(), { id: 'b', input: 700 })]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.summary.totalInput, 300, 'only the entry from today should count');
});

test("days: 'today' skips files whose mtime predates local midnight", async () => {
  const base = makeFixture();
  const todayNoon = atHourToday(12);
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

  // A timestamp inside today's range, in a file whose mtime says it was last
  // written two days ago. Real logs cannot look like this; the assertion pins
  // the optimisation's behaviour so a future reader knows it is deliberate.
  writeSession(base, 'stale', [usageLine(todayNoon.toISOString(), { id: 'c', input: 999 })], twoDaysAgo);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.summary.totalInput, 0, 'a file last written before the cutoff is not opened');
});

test('days: null scans every file regardless of mtime', async () => {
  const base = makeFixture();
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  writeSession(base, 'ancient', [usageLine(old.toISOString(), { id: 'd', input: 42 })], old.getTime());

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: null });

  assert.strictEqual(data.summary.totalInput, 42, 'all-time range has no cutoff and no mtime filter');
});

test("bucket: 'hour' returns 24 slots keyed YYYY-MM-DDTHH, sorted, zero-filled", async () => {
  const base = makeFixture();
  const nineAm = atHourToday(9, 15);
  writeSession(base, 'morning', [usageLine(nineAm.toISOString(), { id: 'e', input: 500 })]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today', bucket: 'hour' });

  // 24 on an ordinary day, 23 on the spring-forward day where 2am does not
  // exist locally. Derived from the day's real length rather than hardcoded, so
  // this does not fail once a year. The fall-back day is 25 hours long but its
  // repeated 1am folds into one key, so the slot count caps at 24.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const expectedSlots = Math.min(Math.round((nextDay - dayStart) / 3600000), 24);
  assert.strictEqual(data.daily.length, expectedSlots, 'every local hour of the day gets a slot');

  const keys = data.daily.map((d) => d.date);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(keys, sorted, 'slots are in chronological order');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(keys[0]), 'hour keys look like 2026-09-21T00');

  const nine = data.daily.find((d) => d.date.endsWith('T09'));
  assert.strictEqual(nine.input, 500, 'usage lands in its local hour');

  const ten = data.daily.find((d) => d.date.endsWith('T10'));
  assert.strictEqual(ten.input, 0, 'an hour with no usage is present and zeroed');
  assert.strictEqual(ten.cost, 0);
});

test("bucket defaults to 'day' and keeps date-only keys", async () => {
  const base = makeFixture();
  writeSession(base, 'morning', [usageLine(atHourToday(9).toISOString(), { id: 'f' })]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.daily.length, 1, 'day bucketing produces one bucket for one day');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(data.daily[0].date), 'day keys have no hour part');
});

test('each bucket carries a byModel token breakdown', async () => {
  const base = makeFixture();
  const nine = atHourToday(9);
  const ten = atHourToday(10);

  writeSession(base, 'mixed', [
    usageLine(nine.toISOString(), { id: 'g1', input: 100, output: 10 }),
    usageLine(ten.toISOString(), { id: 'g2', input: 500, output: 50 }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today', bucket: 'hour' });

  const nineSlot = data.daily.find((d) => d.date.endsWith('T09'));
  assert.deepStrictEqual(nineSlot.byModel, { sonnet: 110 });

  const tenSlot = data.daily.find((d) => d.date.endsWith('T10'));
  assert.deepStrictEqual(tenSlot.byModel, { sonnet: 550 });

  const emptySlot = data.daily.find((d) => d.date.endsWith('T03'));
  assert.deepStrictEqual(emptySlot.byModel, {}, 'a zero-filled slot still has the key');
});

test('byModel totals reconcile with the per-bucket token total', async () => {
  const base = makeFixture();
  writeSession(base, 'one', [usageLine(atHourToday(9).toISOString(), { id: 'h1', input: 700, output: 30 })]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today', bucket: 'hour' });
  const slot = data.daily.find((d) => d.date.endsWith('T09'));

  const fromModels = Object.values(slot.byModel).reduce((a, b) => a + b, 0);
  const fromTypes = slot.input + slot.output + slot.cacheCreate + slot.cacheRead;
  assert.strictEqual(fromModels, fromTypes, 'the two breakdowns of the same bucket must agree');
});

test('each models[] entry carries its family key', async () => {
  const base = makeFixture();
  writeSession(base, 'one', [usageLine(atHourToday(9).toISOString(), { id: 'i1' })]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.models[0].family, 'sonnet');
});

// Like usageLine, but lets a test choose the model and the cache fields.
function modelLine(isoTimestamp, { id, model, input = 0, output = 0, cacheRead = 0 }) {
  return JSON.stringify({
    timestamp: isoTimestamp,
    requestId: 'req-' + id,
    sessionId: 'session-' + id,
    message: {
      id: 'msg-' + id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        speed: 'standard',
      },
    },
  });
}

test('each daily bucket carries cost split by model family', async () => {
  const base = makeFixture();
  const noon = atHourToday(12);

  writeSession(base, 'mixed', [
    modelLine(noon.toISOString(), { id: 'a', model: 'claude-opus-5', output: 1e6 }),
    modelLine(noon.toISOString(), { id: 'b', model: 'claude-haiku-4-5', output: 1e6 }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });
  const bucket = data.daily.find((d) => d.cost > 0);

  assert.ok(Math.abs(bucket.costByModel.opus - 25) < 1e-9, 'Opus 5 output is $25/MTok');
  assert.ok(Math.abs(bucket.costByModel.haiku - 5) < 1e-9, 'Haiku 4.5 output is $5/MTok');

  const summed = Object.values(bucket.costByModel).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(summed - bucket.cost) < 1e-9, 'costByModel sums to the bucket cost');
});

test('activity is a fully populated 7x24 matrix indexed weekday*24+hour', async () => {
  const base = makeFixture();
  const at9 = atHourToday(9, 30);

  writeSession(base, 'one', [
    modelLine(at9.toISOString(), { id: 'a', model: 'claude-opus-5', output: 1e6 }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.activity.length, 168, 'every weekday/hour pair is present');
  for (let i = 0; i < 168; i++) {
    assert.strictEqual(data.activity[i].weekday, Math.floor(i / 24));
    assert.strictEqual(data.activity[i].hour, i % 24);
  }

  const cell = data.activity[at9.getDay() * 24 + 9];
  assert.strictEqual(cell.calls, 1);
  assert.strictEqual(cell.tokens, 1e6);
  assert.ok(Math.abs(cell.cost - 25) < 1e-9, 'one MTok of Opus 5 output is $25');

  const totalCalls = data.activity.reduce((sum, c) => sum + c.calls, 0);
  assert.strictEqual(totalCalls, 1, 'no other cell was touched');
});

// An assistant entry whose content array carries tool_use blocks. toolIds lets
// a test give each block its own id, the way real logs do (toolu_01ABC...).
function toolLine(isoTimestamp, { id, sessionId, toolIds = [] }) {
  const content = [{ type: 'text', text: 'working' }];
  for (const toolId of toolIds) content.push({ type: 'tool_use', id: toolId, name: 'Bash', input: {} });
  return JSON.stringify({
    timestamp: isoTimestamp,
    requestId: 'req-' + id,
    sessionId,
    message: {
      id: 'msg-' + id,
      model: 'claude-opus-5',
      content,
      usage: { input_tokens: 1, output_tokens: 1, speed: 'standard' },
    },
  });
}

test('summary counts distinct sessions, deduped API calls and tool_use blocks', async () => {
  const base = makeFixture();
  const noon = atHourToday(12);
  const iso = noon.toISOString();

  // Real logs split one API response across several JSONL lines that share
  // message.id and requestId. The tool_use blocks frequently ride on a line
  // AFTER the first, which carries none. Both lines must count toward
  // toolCalls even though only the first is kept for sessions/apiCalls.
  const firstLine = toolLine(iso, { id: 'a', sessionId: 's1', toolIds: [] });
  const secondLine = toolLine(iso, { id: 'a', sessionId: 's1', toolIds: ['toolu_01', 'toolu_02'] });

  writeSession(base, 'first', [
    firstLine,
    secondLine, // same message.id:requestId as firstLine - the API-call dedupe drops it, but its tool_use blocks still count
    toolLine(iso, { id: 'b', sessionId: 's1', toolIds: [] }),
  ]);
  writeSession(base, 'second', [toolLine(iso, { id: 'c', sessionId: 's2', toolIds: ['toolu_03'] })]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.summary.sessions, 2, 's1 and s2');
  assert.strictEqual(data.summary.apiCalls, 3, 'the duplicate line is not counted twice');
  assert.strictEqual(data.summary.toolCalls, 3, '2 from the second line of the deduped pair, 0, and 1');
});

// An entry carrying the attribution fields Claude Code writes on each assistant
// line: which skill was active, and which subagent type made the call.
function attributedLine(isoTimestamp, { id, skill, agent, sidechain = false, output = 1e6 }) {
  const entry = {
    timestamp: isoTimestamp,
    requestId: 'req-' + id,
    sessionId: 'session-' + id,
    isSidechain: sidechain,
    message: {
      id: 'msg-' + id,
      model: 'claude-opus-5',
      usage: { input_tokens: 0, output_tokens: output, speed: 'standard' },
    },
  };
  if (skill) entry.attributionSkill = skill;
  if (agent) entry.attributionAgent = agent;
  return JSON.stringify(entry);
}

test('usage is attributed to skills, subagents and the thread it ran on', async () => {
  const base = makeFixture();
  const iso = atHourToday(12).toISOString();

  // $25 of Opus 5 output per line. The first two lines are one API response
  // split across two JSONL lines, so the second must not be counted again.
  const first = attributedLine(iso, { id: 'a', skill: 'playwright-cli', agent: 'Explore', sidechain: true });
  writeSession(base, 'one', [
    first,
    first, // same message.id:requestId - the dedupe drops it
    attributedLine(iso, { id: 'b', skill: 'playwright-cli' }),
    attributedLine(iso, { id: 'c', agent: 'general-purpose', sidechain: true, output: 2e6 }),
    attributedLine(iso, { id: 'd' }), // no attribution at all
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.deepStrictEqual(
    data.skills.map((s) => [s.name, Math.round(s.cost)]),
    [['playwright-cli', 50]],
    'both playwright-cli calls counted once each, sorted by cost'
  );
  assert.deepStrictEqual(
    data.subagents.map((s) => [s.name, Math.round(s.cost)]),
    [['general-purpose', 50], ['Explore', 25]],
    'subagent costs are separate from skill costs, sorted by cost'
  );

  // Every call lands in exactly one thread bucket, so these two sum to the total.
  assert.ok(Math.abs(data.threads.subagent - 75) < 1e-9, 'the two sidechain calls');
  assert.ok(Math.abs(data.threads.main - 50) < 1e-9, 'the two main-thread calls');
  assert.ok(
    Math.abs(data.threads.main + data.threads.subagent - data.summary.totalCost) < 1e-9,
    'the thread split is a partition of total cost'
  );
});

test('cost is split by whether the call ran at over 150k of context', async () => {
  const base = makeFixture();
  const iso = atHourToday(12).toISOString();

  writeSession(base, 'one', [
    // 200k of context: $0.10 of cache reads plus $25 of Opus 5 output.
    modelLine(iso, { id: 'a', model: 'claude-opus-5', cacheRead: 2e5, output: 1e6 }),
    // Exactly at the threshold, which is not over it. $0.075 of cache reads.
    modelLine(iso, { id: 'b', model: 'claude-opus-5', cacheRead: 15e4 }),
    // 1k of context. $0.005 of input.
    modelLine(iso, { id: 'c', model: 'claude-opus-5', input: 1000 }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.ok(Math.abs(data.context.over - 25.1) < 1e-9, 'only the 200k call is over');
  assert.ok(Math.abs(data.context.under - 0.08) < 1e-9, 'the threshold call and the small one are under');
  assert.ok(
    Math.abs(data.context.over + data.context.under - data.summary.totalCost) < 1e-9,
    'the context split is a partition of total cost'
  );
});

test('models[] marks a model with no known price as unpriced', async () => {
  const base = makeFixture();
  const iso = atHourToday(12).toISOString();
  writeSession(base, 'mixed-models', [
    modelLine(iso, { id: 'z', model: 'claude-zeta-9', input: 6e5 }),
    modelLine(iso, { id: 's', model: 'claude-sonnet-4-6-20260115', input: 1000 }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });
  const byName = Object.fromEntries(data.models.map((m) => [m.model, m]));

  assert.strictEqual(byName['claude-zeta-9'].priced, false);
  assert.strictEqual(byName['claude-zeta-9'].cost, 0);
  assert.strictEqual(byName['claude-sonnet-4-6-20260115'].priced, true);
});

test('a line whose timestamp will not parse is skipped, not fatal', async () => {
  const base = makeFixture();
  const good = usageLine(atHourToday(12).toISOString(), { id: 'ok', input: 400 });
  const bad = JSON.stringify({
    timestamp: 'not-a-date',
    requestId: 'req-bad',
    message: { id: 'msg-bad', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
  });

  writeSession(base, 'mixed', [bad, good]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.summary.totalInput, 400, 'the valid line still counts');
  assert.strictEqual(data.summary.apiCalls, 1, 'the unparseable line contributes nothing');
});

test('cache writes count when only the 5m/1h split is present', async () => {
  const base = makeFixture();
  writeSession(base, 'split', [
    JSON.stringify({
      timestamp: atHourToday(12).toISOString(),
      requestId: 'req-split',
      message: {
        id: 'msg-split',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 0 },
        },
      },
    }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  // Opus 5 input is $5/MTok and a 5m cache write is 1.25x that.
  assert.ok(Math.abs(data.summary.totalCost - 6.25) < 1e-9, 'the write is charged');
  assert.strictEqual(data.summary.totalCacheCreate, 1e6, 'and the same tokens are reported');
  assert.strictEqual(data.summary.totalTokens, 1e6, 'so cost and tokens agree');
});

test('a split-only cache write counts toward the 150k context split', async () => {
  const base = makeFixture();
  writeSession(base, 'split-context', [
    JSON.stringify({
      timestamp: atHourToday(12).toISOString(),
      requestId: 'req-sc',
      message: {
        id: 'msg-sc',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 3e5, ephemeral_1h_input_tokens: 0 },
        },
      },
    }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  // 300k of 5m cache writes on Opus 5: 0.3 MTok x $5 x 1.25 = $1.875.
  assert.ok(Math.abs(data.context.over - 1.875) < 1e-9, 'the call is over 150k');
  assert.strictEqual(data.context.under, 0);
});

test('cost and token totals agree when the flat total and the split disagree', async () => {
  const base = makeFixture();
  writeSession(base, 'disagree', [
    JSON.stringify({
      timestamp: atHourToday(12).toISOString(),
      requestId: 'req-dis',
      message: {
        id: 'msg-dis',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 999,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
        },
      },
    }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  // 100 tokens of 5m writes on Opus 5: 100 x $5 x 1.25 / 1e6.
  assert.strictEqual(data.summary.totalCacheCreate, 100, 'the split wins, as it does for cost');
  assert.ok(Math.abs(data.summary.totalCost - 0.000625) < 1e-12);
});

test('a tool_use block with no id is counted once across duplicate lines', async () => {
  const base = makeFixture();
  const line = JSON.stringify({
    timestamp: atHourToday(12).toISOString(),
    requestId: 'req-anon',
    sessionId: 's1',
    message: {
      id: 'msg-anon',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', name: 'Bash', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  writeSession(base, 'anon', [line, line, line]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.summary.apiCalls, 1, 'one API response');
  assert.strictEqual(data.summary.toolCalls, 1, 'and one tool call, not one per line');
});

test('synthetic entries are excluded from every total', async () => {
  const base = makeFixture();
  writeSession(base, 'synth', [
    JSON.stringify({
      timestamp: atHourToday(12).toISOString(),
      message: { id: 'msg-syn', model: '<synthetic>', usage: { input_tokens: 1000, output_tokens: 1000 } },
    }),
    usageLine(atHourToday(12).toISOString(), { id: 'real', input: 100, output: 0 }),
  ]);

  const { scanUsage } = loadScan(base);
  const data = await scanUsage({ days: 'today' });

  assert.strictEqual(data.summary.totalInput, 100, 'synthetic tokens stay out of the totals');
  assert.strictEqual(data.summary.apiCalls, 1, 'a synthetic entry is not an API call');

  // The invariant the byModel test asserts holds only if both sides agree on
  // which entries count.
  const bucket = data.daily[0];
  const fromModels = Object.values(bucket.byModel).reduce((a, b) => a + b, 0);
  assert.strictEqual(fromModels, bucket.input + bucket.output + bucket.cacheCreate + bucket.cacheRead);
});

function costStateLine(isoTimestamp, { sessionId, cost }) {
  return JSON.stringify({ type: 'cost-state', timestamp: isoTimestamp, sessionId, totalCostUSD: cost });
}

test('reportedCost takes the highest cost-state per session and only on an all-time scan', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();

  // s1 writes its cumulative counter three times; only the last value is the
  // session's cost. s2 is a second session, so the two add.
  writeSession(base, 'one', [
    usageLine(iso, { id: 'r1' }),
    costStateLine(iso, { sessionId: 's1', cost: 1.5 }),
    costStateLine(iso, { sessionId: 's1', cost: 4.25 }),
    costStateLine(iso, { sessionId: 's1', cost: 4.25 }),
  ]);
  writeSession(base, 'two', [
    usageLine(iso, { id: 'r2' }),
    costStateLine(iso, { sessionId: 's2', cost: 2.0 }),
  ]);
  // No cost-state at all, so it counts toward `sessions` but not `reportedSessions`.
  writeSession(base, 'three', [usageLine(iso, { id: 'r3' })]);

  const { scanUsage } = loadScan(base);

  const all = await scanUsage({ days: null });
  assert.strictEqual(all.summary.reportedCost, 6.25);
  assert.strictEqual(all.summary.reportedSessions, 2);

  // A windowed scan cannot attribute a session's lifetime total to the window.
  const windowed = await scanUsage({ days: 7 });
  assert.strictEqual(windowed.summary.reportedCost, null);

  // cost-state lines must not leak into the priced totals or the call count.
  assert.strictEqual(all.summary.apiCalls, 3);
});

test('a session with only a cost-state line counts in the reported-sessions denominator', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  // modelLine gives this line sessionId 'session-u1'.
  writeSession(base, 'one', [
    modelLine(iso, { id: 'u1', model: 'claude-sonnet-4-6-20260115', input: 100 }),
    costStateLine(iso, { sessionId: 'session-u1', cost: 1 }),
  ]);
  // Interrupted before any response logged usage: a cost-state line and nothing else.
  writeSession(base, 'ghost', [costStateLine(iso, { sessionId: 'ghost', cost: 3.5 })]);

  const { scanUsage } = loadScan(base);

  const all = await scanUsage({ days: null });
  assert.strictEqual(all.summary.sessions, 1);
  assert.strictEqual(all.summary.reportedSessions, 2);
  assert.strictEqual(all.summary.reportedSessionsOf, 2, 'never smaller than reportedSessions');
  assert.strictEqual(all.summary.reportedCost, 4.5, "the ghost session's cost still counts");

  const windowed = await scanUsage({ days: 7 });
  assert.strictEqual(windowed.summary.reportedSessionsOf, null);
});

// A response's content blocks are written one per JSONL line, sharing message.id
// and requestId. output_tokens grows across those lines as the response streams;
// the other three fields carry their final value on every line.
function streamedResponse(isoTimestamp, { id, outputs, input = 10, cacheRead = 1000 }) {
  return outputs.map((out) =>
    JSON.stringify({
      timestamp: isoTimestamp,
      requestId: 'req-' + id,
      sessionId: 's-' + id,
      message: {
        id: 'msg-' + id,
        model: 'claude-sonnet-4-6-20260115',
        usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: cacheRead },
      },
    })
  );
}

test('a streamed response counts its final output once, not its first or its sum', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'streamed', streamedResponse(iso, { id: 'a', outputs: [5, 5, 5, 367] }));

  const { scanUsage } = loadScan(base);
  const { summary, daily } = await scanUsage({ days: null });

  // 367, not 5 (first line) and not 382 (sum of lines).
  assert.strictEqual(summary.totalOutput, 367);
  // The fields that do not grow must not be multiplied by the line count either.
  assert.strictEqual(summary.totalInput, 10);
  assert.strictEqual(summary.totalCacheRead, 1000);
  assert.strictEqual(summary.apiCalls, 1);
  assert.strictEqual(daily[0].output, 367);
});

test('the same response copied into a second session file is still counted once', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  const lines = streamedResponse(iso, { id: 'b', outputs: [7, 120] });
  writeSession(base, 'original', lines);
  writeSession(base, 'resumed', lines);

  const { scanUsage } = loadScan(base);
  const { summary } = await scanUsage({ days: null });
  assert.strictEqual(summary.totalOutput, 120);
  assert.strictEqual(summary.apiCalls, 1);
});

test('two responses back to back are not merged into one', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  const { scanUsage } = loadScan(base);
  writeSession(base, 'pair', [
    ...streamedResponse(iso, { id: 'c', outputs: [4, 90] }),
    ...streamedResponse(iso, { id: 'd', outputs: [6, 50] }),
  ]);

  const { summary } = await scanUsage({ days: null });
  assert.strictEqual(summary.totalOutput, 140);
  assert.strictEqual(summary.apiCalls, 2);
});

function callLine(isoTimestamp, { id, calls }) {
  return JSON.stringify({
    timestamp: isoTimestamp,
    requestId: 'req-' + id,
    sessionId: 's-' + id,
    message: {
      id: 'msg-' + id,
      model: 'claude-opus-5',
      content: calls.map(([toolId, name, input]) => ({ type: 'tool_use', id: toolId, name, input })),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

function resultLine(isoTimestamp, { toolId, isError }) {
  return JSON.stringify({
    timestamp: isoTimestamp,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError }] },
  });
}

test('tools are grouped by name, with a detail breakdown per tool', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'calls', [
    callLine(iso, {
      id: 'a',
      calls: [
        ['t1', 'Bash', { command: 'git status' }],
        ['t2', 'Bash', { command: 'git log' }],
        ['t3', 'Read', { file_path: '/a/b/one.ts' }],
        ['t4', 'Agent', { subagent_type: 'Explore' }],
      ],
    }),
  ]);

  const { scanUsage } = loadScan(base);
  const { tools, summary } = await scanUsage({ days: null });

  assert.strictEqual(summary.toolCalls, 4);
  assert.deepStrictEqual(
    tools.map((t) => [t.name, t.calls]),
    [['Bash', 2], ['Read', 1], ['Agent', 1]]
  );
  const bash = tools.find((t) => t.name === 'Bash');
  assert.deepStrictEqual(bash.details, [{ name: 'git', calls: 2, errors: 0 }]);
  assert.strictEqual(tools.find((t) => t.name === 'Read').details[0].name, '/a/b/one.ts');
  assert.strictEqual(tools.find((t) => t.name === 'Agent').details[0].name, 'Explore');
});

test('a Bash command behind a cd or env prefix is credited to the real program', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'prefixed', [
    callLine(iso, {
      id: 'b',
      calls: [
        ['p1', 'Bash', { command: 'cd /Users/x/repo && grep -rn foo .' }],
        ['p2', 'Bash', { command: 'grep -c bar file' }],
        ['p3', 'Bash', { command: 'FOO=1 cd /tmp; /usr/bin/git status' }],
        ['p4', 'Bash', { command: 'git diff' }],
      ],
    }),
  ]);

  const { scanUsage } = loadScan(base);
  const { tools } = await scanUsage({ days: null });
  const details = Object.fromEntries(tools.find((t) => t.name === 'Bash').details.map((d) => [d.name, d.calls]));
  // Without prefix stripping these would be `cd` and `FOO=1`, and /usr/bin/git
  // would be its own row rather than folding into git.
  assert.deepStrictEqual(details, { grep: 2, git: 2 });
});

test('an errored tool_result is counted even when it lands in another file', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  // 'zz' sorts after 'aa', so the result file is read first and the join cannot
  // depend on the call having been seen already.
  writeSession(base, 'zz-calls', [
    callLine(iso, { id: 'c', calls: [['e1', 'Bash', { command: 'git push' }], ['e2', 'Bash', { command: 'git pull' }]] }),
  ]);
  writeSession(base, 'aa-results', [
    resultLine(iso, { toolId: 'e1', isError: true }),
    resultLine(iso, { toolId: 'e2', isError: false }),
  ]);

  const { scanUsage } = loadScan(base);
  const { tools, summary } = await scanUsage({ days: null });
  const bash = tools.find((t) => t.name === 'Bash');
  assert.strictEqual(bash.calls, 2);
  assert.strictEqual(bash.errors, 1);
  assert.strictEqual(summary.toolErrors, 1);
  assert.deepStrictEqual(bash.details, [{ name: 'git', calls: 2, errors: 1 }]);
});

// A response line with the fields the efficiency records read. content holds the
// block for this line: a response is one line per block, all sharing id/requestId.
function effCallLine(iso, { id, sessionId = 's1', sidechain = false, model = 'claude-opus-5', input = 10, cacheRead = 0, cacheCreate = 0, output = 5, content = [], version } = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso,
    sessionId,
    isSidechain: sidechain,
    requestId: 'req-' + id,
    version,
    message: {
      id: 'msg-' + id,
      model,
      content,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate },
    },
  });
}

function promptLine(iso, { uuid, sessionId = 's1', content = 'do the thing', origin = { kind: 'human' }, promptSource = 'typed', isMeta } = {}) {
  return JSON.stringify({ type: 'user', timestamp: iso, uuid, sessionId, isMeta, origin, promptSource, message: { role: 'user', content } });
}

test('efficiency.calls holds one record per response, with tool names from every line', async () => {
  const base = makeFixture();
  const t = new Date('2026-09-10T15:00:00Z');
  writeSession(base, 'one', [
    effCallLine(t.toISOString(), { id: 'a', input: 100, cacheRead: 1000, cacheCreate: 50, output: 5, content: [{ type: 'text', text: 'hi' }] }),
    effCallLine(t.toISOString(), { id: 'a', input: 100, cacheRead: 1000, cacheCreate: 50, output: 80, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }),
    effCallLine(new Date(t.getTime() + 1000).toISOString(), { id: 'b', sidechain: true, sessionId: 's1' }),
  ]);

  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: null });

  assert.strictEqual(efficiency.calls.length, 2);
  const a = efficiency.calls.find((c) => c.t === t.getTime());
  assert.deepStrictEqual(a.tools, ['Bash'], 'the tool_use on the second line of the group is kept');
  assert.strictEqual(a.output, 80, 'output comes from the last line of the group');
  assert.strictEqual(a.context, 1150, 'context is input + cacheCreate + cacheRead');
  assert.strictEqual(a.cacheRead, 1000);
  assert.strictEqual(a.main, true);
  assert.strictEqual(a.sessionId, 's1');
  assert.strictEqual(a.model, 'claude-opus-5');
  assert.strictEqual(efficiency.calls.find((c) => c.t !== t.getTime()).main, false);
});

test('efficiency.calls carry the Claude Code version from the line, or null without one', async () => {
  const base = makeFixture();
  const t = new Date('2026-09-10T15:00:00Z');
  writeSession(base, 'one', [
    effCallLine(t.toISOString(), { id: 'a', version: '2.1.286' }),
    effCallLine(new Date(t.getTime() + 1000).toISOString(), { id: 'b' }),
  ]);

  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: null });

  assert.strictEqual(efficiency.calls.find((c) => c.t === t.getTime()).version, '2.1.286');
  assert.strictEqual(efficiency.calls.find((c) => c.t !== t.getTime()).version, null);
});

test('efficiency.prompts keeps typed and queued prompts only, once per uuid', async () => {
  const base = makeFixture();
  const iso = (m) => new Date(Date.UTC(2026, 8, 10, 15, m)).toISOString();
  const lines = [
    promptLine(iso(0), { uuid: 'u1' }),
    promptLine(iso(1), { uuid: 'u2', promptSource: 'queued' }),
    promptLine(iso(2), { uuid: 'u3', isMeta: true }),
    promptLine(iso(3), { uuid: 'u4', content: '<command-name>/handoff</command-name>' }),
    promptLine(iso(4), { uuid: 'u5', origin: { kind: 'task-notification' } }),
    promptLine(iso(5), { uuid: 'u6', origin: null }),
    promptLine(iso(6), { uuid: 'u7', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }),
  ];
  writeSession(base, 'one', lines);
  writeSession(base, 'copy', [promptLine(iso(0), { uuid: 'u1' })]); // a resumed session copies history

  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: null });

  assert.deepStrictEqual(efficiency.prompts.map((p) => p.t).sort(), [Date.parse(iso(0)), Date.parse(iso(1))]);
});

function errorResultLine(isoTimestamp, toolId, content) {
  return JSON.stringify({
    timestamp: isoTimestamp,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: true, content }] },
  });
}

test('tool errors are grouped by cause and by message, with the latest example', async () => {
  const base = makeFixture();
  const at = (h) => atHourToday(h).toISOString();
  writeSession(base, 'calls', [
    callLine(at(9), {
      id: 'err',
      calls: [
        ['x1', 'Bash', { command: 'cd /repo && grep foo src' }],
        ['x2', 'Bash', { command: 'grep bar src' }],
        ['x3', 'Bash', { command: 'git worktree list' }],
        ['x4', 'Bash', { command: 'pnpm test' }],
        ['x5', 'Edit', { file_path: '/a/one.ts' }],
        ['x6', 'Edit', { file_path: '/b/two.ts' }],
        ['x7', 'Read', { file_path: '/c' }],
      ],
    }),
  ]);
  writeSession(base, 'results', [
    errorResultLine(at(9), 'x1', 'Exit code 1\n'),
    errorResultLine(at(10), 'x2', 'Exit code 1\nsrc: nothing'),
    errorResultLine(at(9), 'x3', 'This session is isolated in the worktree /Users/me/wt-1, but this command is too complex to verify'),
    errorResultLine(at(9), 'x4', [{ type: 'text', text: 'Exit code 2\n' + 'x'.repeat(500) }]),
    errorResultLine(at(9), 'x5', '<tool_use_error>String to replace not found in file.\nString: foo</tool_use_error>'),
    errorResultLine(at(11), 'x6', '<tool_use_error>String to replace not found in file.\nString: bar</tool_use_error>'),
    errorResultLine(at(9), 'x7', 'EISDIR: illegal operation on a directory, read \'/c\''),
  ]);

  const { scanUsage } = loadScan(base);
  const { tools, summary } = await scanUsage({ days: null });
  assert.strictEqual(summary.toolErrors, 7);

  const bash = tools.find((t) => t.name === 'Bash');
  assert.deepStrictEqual(bash.errorCauses, [
    { cause: 'command failed', count: 3 },
    { cause: 'blocked by the worktree check', count: 1 },
  ]);
  const grepGroup = bash.errorGroups.find((g) => g.message === 'exit 1 · grep');
  assert.strictEqual(grepGroup.count, 2, 'a leading cd is stripped, so both greps group together');
  assert.strictEqual(grepGroup.example, 'Exit code 1\nsrc: nothing', 'the example is the most recent error');
  assert.strictEqual(grepGroup.t, Date.parse(at(10)));
  const pnpm = bash.errorGroups.find((g) => g.message === 'exit 2 · pnpm');
  assert.strictEqual(pnpm.example.length, 300, 'error text is capped');
  assert.ok(bash.errorGroups.some((g) => g.message === 'This session is isolated in the worktree <path>, but this command is too complex to verify'));

  const edit = tools.find((t) => t.name === 'Edit');
  assert.deepStrictEqual(edit.errorGroups.map((g) => [g.cause, g.message, g.count]), [
    ['tool misused', 'String to replace not found in file.', 2],
  ]);
  assert.strictEqual(tools.find((t) => t.name === 'Read').errorGroups[0].message, "EISDIR: illegal operation on a directory, read '<path>'");
});

test('a tool with no errors has empty error lists', async () => {
  const base = makeFixture();
  writeSession(base, 'calls', [callLine(atHourToday(9).toISOString(), { id: 'ok', calls: [['y1', 'Read', { file_path: '/a' }]] })]);
  const { scanUsage } = loadScan(base);
  const { tools } = await scanUsage({ days: null });
  assert.deepStrictEqual(tools[0].errorCauses, []);
  assert.deepStrictEqual(tools[0].errorGroups, []);
});

test('a price change applies only to usage from its effective date on', async (t) => {
  const { setSnapshots } = require('../lib/pricing');
  t.after(() => setSnapshots([]));
  const base = makeFixture();
  const daysAgo = (n) => {
    const d = atHourToday(12);
    d.setDate(d.getDate() - n);
    return d;
  };
  writeSession(base, 'old', [usageLine(daysAgo(3).toISOString(), { id: 'a', input: 1e6, output: 0 })]);
  writeSession(base, 'new', [usageLine(daysAgo(1).toISOString(), { id: 'b', input: 1e6, output: 0 })]);

  const { scanUsage, localDateStr } = loadScan(base);
  setSnapshots([{
    effectiveFrom: localDateStr(daysAgo(2)),
    rows: [{ match: 'sonnet-4-6', family: 'sonnet', label: 'Sonnet', input: 6, output: 30 }],
  }]);
  const data = await scanUsage({ days: null });

  const costOn = (d) => data.daily.find((x) => x.date === localDateStr(d)).cost;
  assert.ok(Math.abs(costOn(daysAgo(3)) - 3) < 1e-9, 'before the change: $3 per million input');
  assert.ok(Math.abs(costOn(daysAgo(1)) - 6) < 1e-9, 'after the change: $6 per million input');
});

test('a 7-day range starts at local midnight six days ago', async () => {
  const base = makeFixture();
  const firstDay = new Date();
  firstDay.setDate(firstDay.getDate() - 6);
  firstDay.setHours(0, 30, 0, 0);
  const dayBefore = new Date(firstDay);
  dayBefore.setDate(dayBefore.getDate() - 1);
  dayBefore.setHours(23, 59, 59, 0);
  writeSession(base, 'edge', [
    usageLine(dayBefore.toISOString(), { id: 'old', input: 700 }),
    usageLine(firstDay.toISOString(), { id: 'new', input: 300 }),
  ]);

  const { scanUsage, localDateStr } = loadScan(base);
  const data = await scanUsage({ days: 7 });

  assert.strictEqual(data.summary.totalInput, 300, 'the day before the range is left out at any time of day');
  assert.strictEqual(data.daily[0].date, localDateStr(firstDay));
});

test(
  'a file that cannot be read is skipped and counted, and the rest of the scan still runs',
  { skip: process.getuid?.() === 0 && 'root can read a mode-000 file' },
  async () => {
    const base = makeFixture();
    const when = atHourToday(9).toISOString();
    writeSession(base, 'good', [usageLine(when, { id: 'a', input: 300 })]);
    const locked = writeSession(base, 'locked', [usageLine(when, { id: 'b', input: 700 })]);
    fs.chmodSync(locked, 0o000);
    try {
      const { scanUsage } = loadScan(base);
      const data = await scanUsage({ days: null });
      assert.strictEqual(data.summary.totalInput, 300);
      assert.strictEqual(data.meta.unreadableFiles, 1);
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  }
);

test('day buckets run unbroken from the first day with usage to today', async () => {
  const base = makeFixture();
  const threeDaysAgo = atHourToday(12);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  writeSession(base, 'gap', [usageLine(threeDaysAgo.toISOString(), { id: 'a', input: 300 })]);

  const { scanUsage, localDateStr } = loadScan(base);
  const data = await scanUsage({ days: 7 });

  const expected = [3, 2, 1, 0].map((n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return localDateStr(d);
  });
  assert.deepStrictEqual(data.daily.map((d) => d.date), expected);
  assert.deepStrictEqual(
    data.daily.slice(1).map((d) => [d.input, d.cost, d.byModel, d.costByModel]),
    [[0, 0, {}, {}], [0, 0, {}, {}], [0, 0, {}, {}]]
  );
});

// A user line holding one tool_result and the toolUseResult Claude Code stores
// beside it, as an Edit or Write result appears in a transcript.
function editResultLine(isoTimestamp, { toolId, sessionId = 's1', result, sidechain = false }) {
  return JSON.stringify({
    timestamp: isoTimestamp,
    type: 'user',
    sessionId,
    isSidechain: sidechain,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
    toolUseResult: result,
  });
}

function hunk(lines) {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines };
}

test('efficiency.linesBySession counts + and - lines in an Edit hunk', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'edit', [
    editResultLine(iso, {
      toolId: 'toolu_e1',
      result: { filePath: '/a.js', oldString: 'x', newString: 'y', structuredPatch: [hunk([' keep', '-old', '+new', '+new2'])] },
    }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.linesBySession, { s1: { added: 2, removed: 1 } });
});

test('a Write create counts its content lines', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'create', [
    editResultLine(iso, { toolId: 'toolu_c1', sessionId: 'trailing', result: { type: 'create', filePath: '/a', content: 'a\nb\n', structuredPatch: [] } }),
    editResultLine(iso, { toolId: 'toolu_c2', sessionId: 'bare', result: { type: 'create', filePath: '/b', content: 'a\nb', structuredPatch: [] } }),
    editResultLine(iso, { toolId: 'toolu_c3', sessionId: 'empty', result: { type: 'create', filePath: '/c', content: '', structuredPatch: [] } }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.linesBySession, {
    trailing: { added: 2, removed: 0 },
    bare: { added: 2, removed: 0 },
    empty: { added: 0, removed: 0 },
  });
});

test('a Write over an existing file counts its hunks', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'update', [
    editResultLine(iso, {
      toolId: 'toolu_u1',
      result: { type: 'update', filePath: '/a', content: 'new', structuredPatch: [hunk(['-a', '-b', '+new']), hunk(['+tail'])] },
    }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.linesBySession, { s1: { added: 2, removed: 2 } });
});

test('one tool_use_id is counted once across files', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  const line = editResultLine(iso, { toolId: 'toolu_dup', result: { structuredPatch: [hunk(['+a'])] } });
  writeSession(base, 'first', [line]);
  writeSession(base, 'resumed-copy', [line]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.linesBySession, { s1: { added: 1, removed: 0 } });
});

test("a subagent's edits count toward its parent session", async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'parent', [
    editResultLine(iso, { toolId: 'toolu_m', sessionId: 'parent', result: { structuredPatch: [hunk(['+a'])] } }),
    editResultLine(iso, { toolId: 'toolu_s', sessionId: 'parent', sidechain: true, result: { structuredPatch: [hunk(['+b', '-c'])] } }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.linesBySession, { parent: { added: 2, removed: 1 } });
});

test("lines from before the range and Bash edit diffs count nothing", async () => {
  const base = makeFixture();
  const today = atHourToday(9);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  writeSession(base, 'mixed', [
    editResultLine(yesterday.toISOString(), { toolId: 'toolu_y', result: { structuredPatch: [hunk(['+old'])] } }),
    editResultLine(today.toISOString(), { toolId: 'toolu_b', result: { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, shared: false } } }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.linesBySession, {});
});

function titleLine(sessionId, aiTitle) {
  return JSON.stringify({ type: 'ai-title', aiTitle, sessionId });
}

test('efficiency.titleBySession keeps the last ai-title per session', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'titled', [titleLine('s1', 'First'), usageLine(iso, { id: 'a' }), titleLine('s1', 'Second'), titleLine('s2', 'Other')]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.titleBySession, { s1: 'Second', s2: 'Other' });
});

test('an ai-title before older-than-cutoff lines is still read from a file in range', async () => {
  const base = makeFixture();
  const old = new Date(atHourToday(9).getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'titled', [titleLine('s1', 'Early'), usageLine(old, { id: 'old' }), usageLine(iso, { id: 'new' })]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.titleBySession, { s1: 'Early' });
});

test('an ai-title that is not a non-empty string is ignored', async () => {
  const base = makeFixture();
  writeSession(base, 'bad', [titleLine('s1', 'Kept'), titleLine('s1', ''), titleLine('s1', '   '), titleLine('s1', 42), titleLine('s1', null)]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.titleBySession, { s1: 'Kept' });
});

test('efficiency.titleBySession is empty when no session has a title', async () => {
  const base = makeFixture();
  writeSession(base, 'plain', [usageLine(atHourToday(9).toISOString(), { id: 'a' })]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.titleBySession, {});
});

// A line with only the fields the branch read needs. The scan has nothing else to
// count on a system line.
function branchLine(iso, sessionId, gitBranch) {
  return JSON.stringify({ type: 'system', timestamp: iso, sessionId, gitBranch });
}

test('efficiency.branchesBySession lists each branch once, in first-seen order', async () => {
  const base = makeFixture();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'branches', [
    branchLine(iso, 's1', 'main'),
    branchLine(iso, 's1', 'feat/x'),
    branchLine(iso, 's1', 'main'),
    branchLine(iso, 's1', ''),
    branchLine(iso, 's2', 'HEAD'),
    usageLine(iso, { id: 'a' }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.branchesBySession, { s1: ['main', 'feat/x'], s2: ['HEAD'] });
});

test('efficiency.branchBySession is the branch of the newest line, whatever the read order', async () => {
  const base = makeFixture();
  writeSession(base, 'order', [
    branchLine(atHourToday(9).toISOString(), 's1', 'main'),
    branchLine(atHourToday(10).toISOString(), 's1', 'feat/x'),
    branchLine(atHourToday(11).toISOString(), 's1', 'main'),
    branchLine(atHourToday(8).toISOString(), 's1', 'feat/old'),
    usageLine(atHourToday(9).toISOString(), { id: 'a' }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.branchBySession, { s1: 'main' });
});

test('a subagent line on another branch does not change the session branch', async () => {
  const base = makeFixture();
  const sidechain = JSON.stringify({
    type: 'system',
    timestamp: atHourToday(11).toISOString(),
    sessionId: 's1',
    gitBranch: 'HEAD',
    isSidechain: true,
  });
  writeSession(base, 'sidechain', [
    branchLine(atHourToday(9).toISOString(), 's1', 'feat/x'),
    sidechain,
    usageLine(atHourToday(9).toISOString(), { id: 'a' }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.branchBySession, { s1: 'feat/x' });
  assert.deepStrictEqual(efficiency.branchesBySession, { s1: ['feat/x'] });
});

test('a branch on older-than-cutoff lines is still read from a file in range', async () => {
  const base = makeFixture();
  const old = new Date(atHourToday(9).getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  writeSession(base, 'old', [branchLine(old, 's1', 'old-branch'), usageLine(atHourToday(9).toISOString(), { id: 'a' })]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.branchesBySession, { s1: ['old-branch'] });
});

test('efficiency.firstPromptBySession keeps the first typed prompt on one line, even before the cutoff', async () => {
  const base = makeFixture();
  const old = new Date(atHourToday(9).getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const iso = atHourToday(9).toISOString();
  writeSession(base, 'prompts', [
    promptLine(old, { uuid: 'p0', content: '   ' }),
    promptLine(old, { uuid: 'p1', content: '  look at\n\n ideas   and plan  ' }),
    promptLine(iso, { uuid: 'p2', content: 'second prompt' }),
    promptLine(iso, { uuid: 'p3', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }),
    promptLine(iso, { uuid: 'p4', sessionId: 's2', content: 'other session' }),
  ]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.deepStrictEqual(efficiency.firstPromptBySession, { s1: 'look at ideas and plan', s2: 'other session' });
});

test('a first prompt drops pasted_content tags and shows the pasted text', async () => {
  const base = makeFixture();
  const content = '<pasted_content id="x">\nhello there\n</pasted_content> please fix';
  writeSession(base, 'pasted', [promptLine(atHourToday(9).toISOString(), { uuid: 'p1', content })]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  assert.strictEqual(efficiency.firstPromptBySession.s1, 'hello there please fix');
});

test('a first prompt over 80 characters is cut to 80, ending in an ellipsis', async () => {
  const base = makeFixture();
  const content = 'a'.repeat(50) + ' ' + 'b'.repeat(50);
  writeSession(base, 'long', [promptLine(atHourToday(9).toISOString(), { uuid: 'p1', content })]);
  const { scanUsage } = loadScan(base);
  const { efficiency } = await scanUsage({ days: 'today' });
  const expected = 'a'.repeat(50) + ' ' + 'b'.repeat(28) + '…';
  assert.strictEqual(efficiency.firstPromptBySession.s1, expected);
  assert.strictEqual(expected.length, 80);
});
