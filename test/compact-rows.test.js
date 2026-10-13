'use strict';

// Process TZ is set before any Date is made, because aggregate buckets by local time.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const helpers = require('./helpers');
const { NOW, writeCorpus } = require('./golden-corpus');
const { slimUsage, compactRows } = require('../lib/compact-rows');
const { costForUsage, cacheWriteTokens } = require('../lib/pricing');
const { extractFile } = require('../lib/extract');
const { aggregate } = require('../lib/aggregate');

const FULL = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 40,
  cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 },
  speed: 'fast',
  iterations: [{ a: 1 }],
  server_tool_use: { web_search_requests: 0 },
  service_tier: 'standard',
  inference_geo: 'us',
  output_tokens_details: { thinking_tokens: 5 },
  fallback_credit: 0,
};

const emptyRows = (over = {}) => ({ ok: true, calls: [], toolUses: [], errors: [], edits: [], prompts: [], sessions: Object.create(null), minT: 1, maxT: 2, ...over });
// A string with the same characters and its own identity.
const fresh = (s) => JSON.parse(JSON.stringify(s));

test('slimUsage keeps the fields the aggregate reads and drops the rest', () => {
  assert.deepEqual(slimUsage(FULL), {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 },
    speed: 'fast',
    output_tokens_details: { thinking_tokens: 5 },
  });
});

test('slimUsage keeps thinking_tokens only, and a 0 is kept', () => {
  const slim = slimUsage({ output_tokens: 7, output_tokens_details: { thinking_tokens: 0, other: 3 } });
  assert.deepEqual(slim.output_tokens_details, { thinking_tokens: 0 });
});

test('slimUsage of a usage with no thinking_tokens has no output_tokens_details', () => {
  assert.equal('output_tokens_details' in slimUsage({ output_tokens: 7 }), false);
  assert.equal('output_tokens_details' in slimUsage({ output_tokens: 7, output_tokens_details: null }), false);
  assert.equal('output_tokens_details' in slimUsage({ output_tokens: 7, output_tokens_details: {} }), false);
});

test('slimUsage keeps speed only when it is fast', () => {
  assert.equal('speed' in slimUsage({ ...FULL, speed: 'standard' }), false);
});

test('slimUsage of a usage with no cache_creation returns none, so cacheWriteTokens uses the flat total', () => {
  const slim = slimUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 9 });
  assert.equal('cache_creation' in slim, false);
  assert.equal(cacheWriteTokens(slim).write5m, 9);
});

test('slimUsage gives the same cost and cache write tokens as the raw usage', () => {
  const t = Date.parse('2026-10-01T12:00:00Z');
  const usages = [
    { input_tokens: 100, output_tokens: 50 },
    FULL,
    { ...FULL, speed: 'standard' },
    { ...FULL, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 } },
    { ...FULL, cache_creation: undefined },
    { input_tokens: 0, output_tokens: 0 },
    { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 7 },
    { input_tokens: 5, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3 } },
    { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, speed: 'fast' },
    { cache_read_input_tokens: 12 },
  ];
  for (const model of ['claude-opus-4-6-20260315', 'claude-sonnet-4-6-20260115']) {
    for (const u of usages) {
      assert.deepEqual(costForUsage(slimUsage(u), model, t), costForUsage(u, model, t));
      assert.deepEqual(cacheWriteTokens(slimUsage(u)), cacheWriteTokens(u));
    }
  }
});

test('compactRows leaves a tool use with no model key without one, and keeps a null model', () => {
  const rows = emptyRows({ toolUses: [{ key: 'a', t: 1, name: 'Bash', detail: 'ls' }, { key: 'b', t: 2, name: 'Bash', detail: 'ls', model: null }] });
  compactRows(rows);
  assert.equal('model' in rows.toolUses[0], false);
  assert.equal(rows.toolUses[1].model, null);
});

test('compactRows keeps the row set shape', () => {
  const rows = emptyRows({ compactions: [5] });
  rows.sessions.s1 = { branches: [], title: null };
  const out = compactRows(rows);
  assert.equal(out, rows);
  assert.equal(Object.getPrototypeOf(out.sessions), null);
  assert.deepEqual(out.compactions, [5]);
  assert.equal(out.ok, true);
  assert.equal(out.minT, 1);
  assert.equal(out.maxT, 2);
  assert.equal('commands' in out, false);
  assert.equal(out.sessions.s1.title, null);
});

test('compactRows slims call usage and keeps other call keys', () => {
  const rows = emptyRows({ calls: [{ key: 'k', t: 1, sessionId: 's', model: 'm', version: '1', usage: FULL, attributionSkill: null, attributionAgent: null, tools: ['Bash'] }] });
  compactRows(rows);
  assert.deepEqual(Object.keys(rows.calls[0].usage).sort(), ['cache_creation', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens', 'output_tokens_details', 'speed']);
  assert.equal(rows.calls[0].key, 'k');
  assert.deepEqual(rows.calls[0].tools, ['Bash']);
});

test('two row sets compacted with one intern map share equal sessionId strings', () => {
  const intern = new Map();
  const make = () => emptyRows({ calls: [{ key: 'k', t: 1, sessionId: fresh('session-abc'), model: fresh('claude-x'), usage: {}, tools: [] }], prompts: [{ id: 'p', t: 1, sessionId: fresh('session-abc') }] });
  const a = compactRows(make(), intern);
  const b = compactRows(make(), intern);
  assert.ok(Object.is(a.calls[0].sessionId, b.calls[0].sessionId));
  assert.ok(Object.is(a.calls[0].sessionId, a.prompts[0].sessionId));
  assert.ok(Object.is(a.calls[0].model, b.calls[0].model));
});

test('compactRows passes a failed row set through unchanged', () => {
  const rows = emptyRows({ ok: false, calls: [{ usage: FULL }] });
  compactRows(rows);
  assert.deepEqual(rows.calls[0].usage, FULL);
});

test('aggregate of compacted rows equals aggregate of raw rows over the golden corpus', async (t) => {
  const dir = helpers.tmpDir(t, 'compact');
  const { shared } = writeCorpus(dir);
  const raw = [];
  for (const name of shared) raw.push(await extractFile(path.join(dir, name)));
  const compacted = raw.map((r) => compactRows(structuredClone(r)));
  for (const days of [null, 7]) {
    const opts = { days, now: NOW, projectsDir: dir };
    assert.deepStrictEqual(aggregate(compacted, opts), aggregate(raw, opts));
  }
});
