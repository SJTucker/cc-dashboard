'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/scan.js reads CLAUDE_CONFIG_DIR when it loads, so each fixture gets fresh
// copies of every module that depends on it.
function load(base) {
  process.env.CLAUDE_CONFIG_DIR = base;
  delete process.env.REVIEWS_DIR;
  delete process.env.LIVE_SESSIONS_DIR;
  for (const m of ['../lib/scan', '../lib/sessions', '../lib/updates', '../lib/review']) {
    delete require.cache[require.resolve(m)];
  }
  return { review: require('../lib/review'), scan: require('../lib/scan') };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-review-'));

const typed = (text) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});

function writeTranscript(dir, lines, name = 's.jsonl') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('digestTranscript lists prompts, replies, tools, errors, large output and compactions in order', async () => {
  const base = tmpDir();
  const { review, scan } = load(base);
  const file = writeTranscript(base, [
    typed('fix the build'),
    say('Looking at the build.'),
    toolUse('t1', 'Read', { file_path: '/a.js' }),
    toolResult('t1', 'x'.repeat(12_000)),
    toolUse('t2', 'Bash', { command: 'ls -la' }),
    toolResult('t2', 'Exit code 1\nno such file', true),
    { type: 'system', subtype: 'compact_boundary' },
    { ...typed('summary of the earlier conversation'), isCompactSummary: true },
    typed('now commit'),
  ]);
  const bash = scan.toolDetail('Bash', { command: 'ls -la' });
  assert.deepStrictEqual(await review.digestTranscript(file), {
    prompts: 2,
    text: [
      'USER: fix the build',
      'CLAUDE: Looking at the build.',
      'TOOL Read /a.js',
      'LARGE OUTPUT Read: 12000 chars',
      bash ? `TOOL Bash ${bash}` : 'TOOL Bash',
      'ERROR Bash: Exit code 1 no such file',
      'COMPACTED',
      'USER: now commit',
    ].join('\n'),
  });
});

test('digestTranscript skips subagent lines, slash commands and repeated tool_use blocks', async () => {
  const base = tmpDir();
  const { review } = load(base);
  const file = writeTranscript(base, [
    typed('<command-name>/clear</command-name>'),
    { ...typed('a subagent task'), isSidechain: true },
    { ...toolUse('t9', 'Read', { file_path: '/sub.js' }), isSidechain: true },
    toolUse('t1', 'Read', { file_path: '/a.js' }),
    toolUse('t1', 'Read', { file_path: '/a.js' }),
  ]);
  assert.deepStrictEqual(await review.digestTranscript(file), { prompts: 0, text: 'TOOL Read /a.js' });
});

test('digestTranscript skips a line that is not JSON and reads on', async () => {
  const base = tmpDir();
  const { review } = load(base);
  const file = writeTranscript(base, [typed('first'), '{"type":"user","mess', typed('second')]);
  assert.deepStrictEqual(await review.digestTranscript(file), { prompts: 2, text: 'USER: first\nUSER: second' });
});

test('digestTranscript keeps the start and end of a long session', async () => {
  const base = tmpDir();
  const { review } = load(base);
  const lines = Array.from({ length: 400 }, (_, i) => typed(`p${i} ${'x'.repeat(300)}`));
  const { prompts, text } = await review.digestTranscript(writeTranscript(base, lines));
  assert.strictEqual(prompts, 400);
  assert.ok(text.startsWith('USER: p0 '));
  assert.ok(text.endsWith(`USER: p399 ${'x'.repeat(300)}`));
  assert.match(text, /\n\[\.\.\. \d+ characters cut \.\.\.\]\n/);
  assert.ok(text.length < 60_100);
});

test('digestTranscript returns null for a missing file', async () => {
  const base = tmpDir();
  const { review } = load(base);
  assert.strictEqual(await review.digestTranscript(path.join(base, 'gone.jsonl')), null);
});
