'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// scanUsage resolves its directory from CLAUDE_CONFIG_DIR at call time, so each
// test points it at a throwaway fixture tree: <tmp>/projects/<project>/<file>.jsonl
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-test-'));
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  return base;
}

// One usage line in the shape lib/scan.js expects.
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

function loadScan(base) {
  process.env.CLAUDE_CONFIG_DIR = base;
  delete require.cache[require.resolve('../lib/scan')];
  return require('../lib/scan');
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
