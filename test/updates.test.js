'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CLAUDE_CONFIG_DIR is read at call time, so each test points it at a throwaway
// folder and requires fresh copies.
function setup({ verdicts } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-updates-'));
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = base;
  const file = path.join(base, 'cc-dashboard', 'updates.json');
  if (verdicts !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof verdicts === 'string' ? verdicts : JSON.stringify(verdicts));
  }
  delete require.cache[require.resolve('../lib/scan')];
  delete require.cache[require.resolve('../lib/updates')];
  return { updates: require('../lib/updates'), base, file };
}

const CHANGELOG = [
  '# Changelog',
  '',
  '## 2.1.287',
  '',
  '- Fixed a crash in the IDE extension',
  '',
  '## 2.1.286 (2026-10-01)',
  '',
  '- Subagents now share the parent prompt cache',
  '### Notes',
  '- Nested heading stays in the entry',
  '',
  '## [2.1.285]',
  '- Compaction keeps tool results shorter',
  '',
  '## Older releases',
  '- not a version',
].join('\n');

test('parseChangelog maps each version heading to its entry, extra heading text allowed', () => {
  const { updates } = setup();
  const entries = updates.parseChangelog(CHANGELOG);
  assert.deepStrictEqual([...entries.keys()], ['2.1.287', '2.1.286', '2.1.285']);
  assert.strictEqual(entries.get('2.1.287'), '- Fixed a crash in the IDE extension');
  assert.match(entries.get('2.1.286'), /prompt cache[\s\S]*### Notes[\s\S]*Nested heading/);
  assert.strictEqual(entries.get('2.1.285'), '- Compaction keeps tool results shorter');
});

test('transcriptVersions reads only the top-level version field of each line', async () => {
  const { updates, base } = setup();
  fs.writeFileSync(path.join(base, 'projects', 'demo', 's.jsonl'), [
    JSON.stringify({ type: 'user', version: '2.1.285' }),
    JSON.stringify({ type: 'assistant', version: '2.1.286', toolUseResult: { version: '1.0.0' } }),
    JSON.stringify({ type: 'summary' }),
    'not json',
  ].join('\n') + '\n');
  assert.deepStrictEqual([...(await updates.transcriptVersions())].sort(), ['2.1.285', '2.1.286']);
});

test('pendingVersions keeps seen versions with no verdict and a changelog entry, oldest first', () => {
  const { updates } = setup();
  const changelog = updates.parseChangelog(CHANGELOG);
  const seen = ['2.1.287', '2.1.285', '2.1.286', '2.1.290', '2.1.289-dev.20261001'];
  assert.deepStrictEqual(updates.pendingVersions(seen, { '2.1.286': { relevant: false } }, changelog), ['2.1.285', '2.1.287']);
});

test('compareVersions orders by number, not by text', () => {
  const { updates } = setup();
  assert.deepStrictEqual(['2.1.10', '2.1.9', '2.0.99'].sort(updates.compareVersions), ['2.0.99', '2.1.9', '2.1.10']);
});

test('buildPrompt puts the topics in the system prompt and every entry in the prompt', () => {
  const { updates } = setup();
  const { system, prompt } = updates.buildPrompt([['2.1.286', '- Subagents share the cache'], ['2.1.287', '- IDE fix']]);
  for (const topic of ['prompt caching', 'context window', 'compaction', 'subagents', 'effort', '15 words', 'JSON array']) {
    assert.ok(system.includes(topic), `system prompt names ${topic}`);
  }
  assert.match(prompt, /## 2\.1\.286\n- Subagents share the cache/);
  assert.match(prompt, /## 2\.1\.287\n- IDE fix/);
});

test('parseReply reads plain and fenced JSON, keeps only asked versions, and keeps relevant without a summary as relevant only', () => {
  const { updates } = setup();
  const reply = [
    { version: '2.1.286', relevant: true, summary: ' Subagents share the parent cache ' },
    { version: '2.1.287', relevant: false, summary: 'ignored' },
    { version: '2.1.288', relevant: true, summary: '' },
    { version: '9.9.9', relevant: true, summary: 'not asked' },
    { version: '2.1.289', relevant: 'yes' },
  ];
  const asked = ['2.1.286', '2.1.287', '2.1.288', '2.1.289'];
  const expected = {
    '2.1.286': { relevant: true, summary: 'Subagents share the parent cache' },
    '2.1.287': { relevant: false },
    '2.1.288': { relevant: true },
  };
  assert.deepStrictEqual(updates.parseReply(JSON.stringify(reply), asked), expected);
  assert.deepStrictEqual(updates.parseReply('```json\n' + JSON.stringify(reply) + '\n```', asked), expected);
  assert.deepStrictEqual(updates.parseReply('Here are the verdicts:', asked), {});
  assert.deepStrictEqual(updates.parseReply('{"version":"2.1.286"}', asked), {});
});

test('readVerdicts returns {} for a missing, malformed or non-object file', () => {
  assert.deepStrictEqual(setup().updates.readVerdicts(), {});
  assert.deepStrictEqual(setup({ verdicts: '{nope' }).updates.readVerdicts(), {});
  assert.deepStrictEqual(setup({ verdicts: '[]' }).updates.readVerdicts(), {});
});

test('recordVerdicts creates the folder, stamps judgedAt and returns the versions added', () => {
  const { updates, file } = setup();
  const added = updates.recordVerdicts({ '2.1.286': { relevant: true, summary: 'Cache shared' } }, Date.UTC(2026, 9, 5, 9, 12));
  assert.deepStrictEqual(added, ['2.1.286']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    '2.1.286': { relevant: true, summary: 'Cache shared', judgedAt: '2026-10-05T09:12:00.000Z' },
  });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['updates.json'], 'no temp file left behind');
});

test('recordVerdicts never replaces an existing entry', () => {
  const hand = { '2.1.286': { relevant: false, judgedAt: '2026-10-01T00:00:00.000Z', note: 'hand edit' } };
  const { updates, file } = setup({ verdicts: hand });
  const added = updates.recordVerdicts({ '2.1.286': { relevant: true, summary: 'x' }, '2.1.287': { relevant: false } }, 0);
  assert.deepStrictEqual(added, ['2.1.287']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after['2.1.286'], hand['2.1.286']);
  assert.strictEqual(after['2.1.287'].relevant, false);
});

test('recordVerdicts refuses to replace a malformed file', () => {
  const { updates, file } = setup({ verdicts: '{"2.1.286": {"relevant": tru' });
  assert.throws(() => updates.recordVerdicts({ '2.1.287': { relevant: false } }), /not a JSON object/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"2.1.286": {"relevant": tru');
});

test('getUpdatesPath is updates.json under CLAUDE_CONFIG_DIR', () => {
  const { updates, file } = setup();
  assert.strictEqual(updates.getUpdatesPath(), file);
});
