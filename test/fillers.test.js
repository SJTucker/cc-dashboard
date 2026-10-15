'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { contextFillers, FILLER_LIMIT } = require('../lib/fillers');

const use = (name, detail, group) => ({ name, detail, model: null, group: group ?? null });
const res = (t, chars, sessionId = 's1', agentId = null) => ({ t, chars, sessionId, agentId });

test('results group by Bash command group, file path or tool name, largest total first', () => {
  const tools = new Map([
    ['b1', use('Bash', 'sed', 'sed -n')],
    ['b2', use('Bash', 'sed', 'sed -n')],
    ['r1', use('Read', '/r/a.js')],
    ['w1', use('WebSearch', null)],
  ]);
  const results = new Map([['b1', res(1, 100)], ['b2', res(2, 300, 's2')], ['r1', res(3, 250)], ['w1', res(4, 10)]]);
  const { rows, totals } = contextFillers(tools, results);
  assert.deepStrictEqual(rows.map((r) => [r.tool, r.group, r.calls, r.sessions, r.chars, r.median, r.max]), [
    ['Bash', 'sed -n', 2, 2, 400, 200, 300],
    ['Read', '/r/a.js', 1, 1, 250, 250, 250],
    ['WebSearch', 'WebSearch', 1, 1, 10, 10, 10],
  ]);
  assert.deepStrictEqual(totals, { chars: 660, results: 4 });
});

test('a Bash tool use without a group falls back to its program', () => {
  const { rows } = contextFillers(new Map([['b', use('Bash', 'git')]]), new Map([['b', res(1, 5)]]));
  assert.strictEqual(rows[0].group, 'git');
});

test('a result with no stored tool use is left out', () => {
  const { rows, totals } = contextFillers(new Map(), new Map([['x', res(1, 99)]]));
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(totals, { chars: 0, results: 0 });
});

test('a Read of a file the same thread read with no edit between is a re-read', () => {
  const tools = new Map([
    ['r1', use('Read', '/a')], ['r2', use('Read', '/a')], ['e1', use('Edit', '/a')], ['r3', use('Read', '/a')],
    ['r4', use('Read', '/a')], // another subagent: its own thread
  ]);
  const results = new Map([
    ['r1', res(1, 10)], ['r2', res(2, 10)], ['e1', res(3, 1)], ['r3', res(4, 10)], ['r4', res(5, 10, 's1', 'agentB')],
  ]);
  const read = contextFillers(tools, results).rows.find((r) => r.tool === 'Read');
  assert.strictEqual(read.calls, 4);
  assert.strictEqual(read.rereads, 1, 'only r2: r3 follows an edit and r4 is another thread');
});

test('at most FILLER_LIMIT rows are returned', () => {
  const tools = new Map();
  const results = new Map();
  for (let i = 0; i < FILLER_LIMIT + 5; i++) {
    tools.set(`k${i}`, use('Read', `/f${i}`));
    results.set(`k${i}`, res(i, i + 1));
  }
  const { rows } = contextFillers(tools, results);
  assert.strictEqual(rows.length, FILLER_LIMIT);
  assert.strictEqual(rows[0].chars, FILLER_LIMIT + 5);
});
