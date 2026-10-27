'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { getHeadlessUsageDir, findHeadlessFiles, readHeadlessUsage } = require('../lib/headless-usage');

const STEPS = [
  { t: 1000, model: 'claude-haiku-5-5', input: 2, cacheWrite: 3238, cacheRead: 28335, output: 111, turnId: 't1', index: 1 },
  { t: 1001, model: 'claude-haiku-5-5', agentId: 'a1', input: 2, cacheWrite: 21918, cacheRead: 0, output: 55, turnId: 't2', index: 0 },
];

function write(t, steps, text) {
  const dir = tmpDir(t, 'headless');
  const file = path.join(dir, 's1.json');
  fs.writeFileSync(file, text ?? JSON.stringify({ sessionId: 's1', cwd: '/w', reportedCost: 0.0042, steps }));
  return file;
}

test('readHeadlessUsage turns each step into a call row', async (t) => {
  const rows = await readHeadlessUsage(write(t, STEPS));
  assert.strictEqual(rows.ok, true);
  assert.deepStrictEqual(rows.calls.map((c) => c.key), ['headless:s1:main:t1:1:1000', 'headless:s1:a1:t2:0:1001']);
  assert.deepStrictEqual(rows.calls.map((c) => [c.sessionId, c.sidechain, c.agentId]), [['s1', false, undefined], ['s1', true, 'a1']]);
  assert.deepStrictEqual(rows.calls[0].usage, { input_tokens: 2, output_tokens: 111, cache_read_input_tokens: 28335, cache_creation_input_tokens: 3238, cache_creation: { ephemeral_1h_input_tokens: 3238, ephemeral_5m_input_tokens: 0 } });
  assert.deepStrictEqual([rows.calls[0].version, rows.calls[0].attributionSkill, rows.calls[0].attributionAgent, rows.calls[0].tools], [null, null, null, []]);
});

test('a main step prices its cache write as 1h, a subagent step as 5m', async (t) => {
  const { calls } = await readHeadlessUsage(write(t, STEPS));
  assert.deepStrictEqual(calls[0].usage.cache_creation, { ephemeral_1h_input_tokens: 3238, ephemeral_5m_input_tokens: 0 });
  assert.deepStrictEqual(calls[1].usage.cache_creation, { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 21918 });
});

test('the row set is headless with a non-interactive session and min/max t', async (t) => {
  const rows = await readHeadlessUsage(write(t, STEPS));
  assert.strictEqual(rows.headless, true);
  assert.strictEqual(rows.sessions.s1.nonInteractive, true);
  assert.deepStrictEqual([rows.minT, rows.maxT], [1000, 1001]);
  assert.deepStrictEqual(rows.toolUses, []);
});

test('two steps with the same turnId, index and t but different agentId get different keys', async (t) => {
  const same = { t: 5, model: 'm', input: 1, cacheWrite: 1, cacheRead: 1, output: 1, turnId: 't1', index: 0 };
  const { calls } = await readHeadlessUsage(write(t, [same, { ...same, agentId: 'a1' }]));
  assert.strictEqual(new Set(calls.map((c) => c.key)).size, 2);
});

test('an unparseable file returns ok: false', async (t) => {
  const rows = await readHeadlessUsage(write(t, null, '{"steps":[{"t":1'));
  assert.strictEqual(rows.ok, false);
  assert.deepStrictEqual(rows.calls, []);
});

test('a step with a bad count is dropped', async (t) => {
  const { calls } = await readHeadlessUsage(write(t, [{ ...STEPS[0], output: -1 }, { ...STEPS[1], input: '2' }, STEPS[0]]));
  assert.strictEqual(calls.length, 1);
});

test('findHeadlessFiles lists *.json in the folder, and nothing for a missing one', (t) => {
  const file = write(t, STEPS);
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  assert.deepStrictEqual(findHeadlessFiles(dir), [file]);
  assert.deepStrictEqual(findHeadlessFiles(path.join(dir, 'missing')), []);
  assert.strictEqual(getHeadlessUsageDir('/c'), path.join('/c', 'cc-dashboard', 'headless-usage'));
});

test('a row set has no agentSteps key, so aggregate and the row store treat it as transcript rows', async (t) => {
  const rows = await readHeadlessUsage(write(t, STEPS));
  assert.equal('agentSteps' in rows, false);
  assert.equal('agentSteps' in (await readHeadlessUsage(write(t, null, '{'))), false);
});

test('a cost-only file with no steps is ok, with no calls and null minT and maxT', async (t) => {
  const rows = await readHeadlessUsage(write(t, []));
  assert.strictEqual(rows.ok, true);
  assert.deepStrictEqual(rows.calls, []);
  assert.deepStrictEqual([rows.minT, rows.maxT], [null, null]);
});
