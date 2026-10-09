'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { extractFile } = require('../lib/extract');

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-01T11:00:00.000Z';

// Writes one transcript from line objects and returns its path.
function writeTranscript(t, lines) {
  const file = path.join(helpers.tmpDir(t, 'extract-order'), 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const assistantLine = {
  type: 'assistant',
  timestamp: T0,
  sessionId: 's1',
  requestId: 'r1',
  message: { id: 'm1', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 10, output_tokens: 5 } },
};

test('a branch carried only by a typed prompt is still recorded', async (t) => {
  const file = writeTranscript(t, [
    {
      type: 'user',
      sessionId: 's1',
      timestamp: T0,
      origin: { kind: 'human' },
      promptSource: 'typed',
      gitBranch: 'only-on-prompt',
      message: { content: 'hello' },
    },
    assistantLine,
  ]);
  const rows = await extractFile(file);
  assert.deepStrictEqual(rows.sessions.s1.branches, ['only-on-prompt']);
  assert.deepStrictEqual(rows.sessions.s1.newestBranch, { t: Date.parse(T0), branch: 'only-on-prompt' });
});

test('the timestamp of an edit extends maxT', async (t) => {
  const file = writeTranscript(t, [
    assistantLine,
    {
      type: 'user',
      sessionId: 's1',
      timestamp: T1,
      toolUseResult: { structuredPatch: [{ lines: ['+a'] }] },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
    },
  ]);
  const rows = await extractFile(file);
  assert.strictEqual(rows.maxT, Date.parse(T1));
  assert.strictEqual(rows.minT, Date.parse(T0));
});
