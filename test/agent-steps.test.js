'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { getAgentUsageDir, findStepFiles, readAgentSteps, stepKey } = require('../lib/agent-steps');

const STEP = { t: 1000, model: 'claude-haiku-4-5', input: 2, cacheWrite: 3649, cacheRead: 33650, output: 163, turnId: 't1', index: 1 };

function writeStepFile(text, name = 'a1.json') {
  const dir = helpers.tmpDir(null, 'agent-steps');
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('getAgentUsageDir is cc-dashboard/agent-usage under the config dir', () => {
  assert.strictEqual(getAgentUsageDir('/c'), path.join('/c', 'cc-dashboard', 'agent-usage'));
});

test('readAgentSteps takes the agent id from the file name and keeps each step', async () => {
  const file = writeStepFile(JSON.stringify({ agentId: 'a1', steps: [STEP, { ...STEP, t: 2000, index: 2, output: 50 }] }));
  const rows = await readAgentSteps(file);
  assert.strictEqual(rows.ok, true);
  assert.deepStrictEqual(rows.agentSteps, [
    { agentId: 'a1', t: 1000, model: 'claude-haiku-4-5', input: 2, cacheWrite: 3649, cacheRead: 33650, output: 163 },
    { agentId: 'a1', t: 2000, model: 'claude-haiku-4-5', input: 2, cacheWrite: 3649, cacheRead: 33650, output: 50 },
  ]);
  assert.deepStrictEqual([rows.minT, rows.maxT], [1000, 2000]);
  assert.deepStrictEqual([rows.calls, rows.toolUses, rows.errors, rows.edits, rows.prompts, rows.commands], [[], [], [], [], [], []]);
  assert.strictEqual(Object.getPrototypeOf(rows.sessions), null);
});

test('readAgentSteps of a file that does not parse is not ok, so the row store reads it again', async () => {
  for (const text of ['', '{"agentId":"a1","steps":[{"t":1', 'null']) {
    const rows = await readAgentSteps(writeStepFile(text));
    assert.strictEqual(rows.ok, text === 'null', JSON.stringify(text));
    assert.deepStrictEqual(rows.agentSteps, []);
  }
});

test('readAgentSteps skips a step with a missing or non-numeric count', async () => {
  const bad = [{ ...STEP, output: 'x' }, { ...STEP, input: undefined }, { ...STEP, cacheRead: -1 }, null, 7];
  const rows = await readAgentSteps(writeStepFile(JSON.stringify({ agentId: 'a1', steps: [...bad, STEP] })));
  assert.strictEqual(rows.ok, true);
  assert.strictEqual(rows.agentSteps.length, 1);
});

test('readAgentSteps of a missing file is not ok', async () => {
  const rows = await readAgentSteps(path.join(helpers.tmpDir(null, 'agent-steps'), 'gone.json'));
  assert.strictEqual(rows.ok, false);
});

test('findStepFiles lists the .json files in the folder and nothing else', () => {
  const dir = helpers.tmpDir(null, 'agent-steps');
  fs.writeFileSync(path.join(dir, 'a1.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a2.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  fs.mkdirSync(path.join(dir, 'sub.json'));
  assert.deepStrictEqual(findStepFiles(dir).sort(), [path.join(dir, 'a1.json'), path.join(dir, 'a2.json')]);
});

test('findStepFiles of no folder, or a missing one, is empty', () => {
  assert.deepStrictEqual(findStepFiles(null), []);
  assert.deepStrictEqual(findStepFiles(path.join(helpers.tmpDir(null, 'agent-steps'), 'missing')), []);
});

test('stepKey joins the agent id and the three input-side counts', () => {
  assert.strictEqual(stepKey('a1', 2, 3649, 33650), 'a1:2:3649:33650');
});
