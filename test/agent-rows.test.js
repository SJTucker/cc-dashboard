'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { isSubagentFile, agentRow, agentIdOf } = require('../lib/agent-rows');

function writeAgent(rel, firstLine, meta) {
  const base = helpers.tmpDir(null, 'agent-rows');
  const file = path.join(base, 'demo', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, firstLine + '\n{"second":1}\n');
  if (meta !== undefined) fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
  return file;
}
const first = { timestamp: '2026-11-17T10:00:00.000Z', type: 'user' };

test('isSubagentFile matches subagent transcripts only', () => {
  assert.strictEqual(isSubagentFile('/p/demo/s/subagents/agent-a1.jsonl'), true);
  assert.strictEqual(isSubagentFile('/p/demo/s/subagents/workflows/wf_1/agent-a2.jsonl'), true);
  assert.strictEqual(isSubagentFile('/p/demo/s.jsonl'), false);
  assert.strictEqual(isSubagentFile('/p/demo/s/subagents/agent-a1.meta.json'), false);
});

test('agentRow reads the meta file and the first line\'s timestamp', () => {
  const file = writeAgent('s/subagents/agent-a1.jsonl', JSON.stringify(first), { agentType: 'Explore', description: 'Map tab', toolUseId: 'toolu_1' });
  assert.deepStrictEqual(agentRow(file), {
    agentId: 'a1', sessionId: 's', agentType: 'Explore', description: 'Map tab', toolUseId: 'toolu_1',
    parentAgentId: null, startedAt: Date.parse('2026-11-17T10:00:00.000Z'), hasMeta: true,
  });
});

test('agentRow takes the session id from above subagents for a workflow subagent', () => {
  const file = writeAgent('s/subagents/workflows/wf_1/agent-a2.jsonl', JSON.stringify(first), { agentType: 'x' });
  const row = agentRow(file);
  assert.strictEqual(row.agentId, 'a2');
  assert.strictEqual(row.sessionId, 's');
});

test('agentRow reads a first line longer than 64 KiB', () => {
  const file = writeAgent('s/subagents/agent-a3.jsonl', JSON.stringify({ ...first, prompt: 'x'.repeat(100 * 1024) }), {});
  assert.strictEqual(agentRow(file).startedAt, Date.parse(first.timestamp));
});

test('agentRow without a meta file gives hasMeta false and nulls', () => {
  const file = writeAgent('s/subagents/agent-a4.jsonl', JSON.stringify(first));
  const row = agentRow(file);
  assert.strictEqual(row.hasMeta, false);
  assert.deepStrictEqual([row.agentType, row.description, row.toolUseId, row.parentAgentId], [null, null, null, null]);
});

test('agentRow with a malformed meta file gives hasMeta false and nulls', () => {
  const file = writeAgent('s/subagents/agent-a5.jsonl', JSON.stringify(first), '{not json');
  const row = agentRow(file);
  assert.strictEqual(row.hasMeta, false);
  assert.strictEqual(row.description, null);
});

test('agentIdOf strips the agent- prefix and the .jsonl suffix', () => {
  assert.strictEqual(agentIdOf('/p/demo/s/subagents/agent-a1.jsonl'), 'a1');
  assert.strictEqual(agentIdOf('/p/demo/s/subagents/workflows/wf_1/agent-b2c.jsonl'), 'b2c');
});
