'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractFile, EXTRACT_VERSION } = require('../lib/extract');

const ROOT = path.join(__dirname, '..');

// Writes one transcript from line objects and returns its path.
function writeTranscript(lines) {
  const dir = helpers.tmpDir(null, 'extract');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-01T10:00:05.000Z';
const T2 = '2026-10-01T10:00:09.000Z';

// One assistant line. `content` and `output` vary per test, the rest is fixed.
function assistant({ ts = T0, msg = 'm1', req = 'r1', output = 5, content = [], extra = {} } = {}) {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 's1',
    requestId: req,
    message: { id: msg, model: 'claude-sonnet-4-6', content, usage: { input_tokens: 10, output_tokens: output } },
    ...extra,
  };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('EXTRACT_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(EXTRACT_VERSION) && EXTRACT_VERSION >= 1);
});

test('the lines of one response merge into one call: highest output_tokens, tools of every line, first line time', async () => {
  const file = writeTranscript([
    assistant({ ts: T0, output: 5, content: [toolUse('t1', 'Bash', { command: 'ls' })] }),
    assistant({ ts: T1, output: 5, content: [{ type: 'text', text: 'hi' }] }),
    assistant({ ts: T2, output: 367, content: [toolUse('t2', 'Read', { file_path: '/a' })] }),
  ]);
  const rows = await extractFile(file);

  assert.strictEqual(rows.ok, true);
  assert.strictEqual(rows.calls.length, 1);
  const [call] = rows.calls;
  assert.strictEqual(call.key, 'm1:r1');
  assert.strictEqual(call.t, Date.parse(T0));
  assert.strictEqual(call.usage.output_tokens, 367);
  assert.deepStrictEqual(call.tools, ['Bash', 'Read']);
  assert.strictEqual(call.sessionId, 's1');
  assert.strictEqual(call.model, 'claude-sonnet-4-6');
});

test('two responses make two calls, and a line with no ids is its own call', async () => {
  const file = writeTranscript([
    assistant({ msg: 'm1', req: 'r1' }),
    assistant({ msg: 'm2', req: 'r2' }),
    { ...assistant({ msg: 'm3', req: 'r3' }), requestId: undefined },
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.calls.map((c) => c.key), ['m1:r1', 'm2:r2', null]);
});

test('a synthetic model and an unparseable timestamp produce no call and no tool use', async () => {
  const synthetic = assistant({ msg: 'm1', content: [toolUse('t1', 'Bash', {})] });
  synthetic.message.model = '<synthetic>';
  const file = writeTranscript([synthetic, assistant({ msg: 'm2', req: 'r2', ts: 'not a date', content: [toolUse('t2', 'Bash', {})] })]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.calls, []);
  assert.deepStrictEqual(rows.toolUses, []);
});

test('tool uses on later lines of a group are kept, with detail and a fallback key', async () => {
  const file = writeTranscript([
    assistant({ ts: T0, content: [{ type: 'text', text: 'x' }] }),
    assistant({ ts: T1, content: [toolUse('toolu_1', 'Bash', { command: 'cd /x && git status' }), toolUse(undefined, 'Read', { file_path: '/a.js' })] }),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.toolUses, [
    { key: 'toolu_1', t: Date.parse(T1), name: 'Bash', detail: 'git', model: 'claude-sonnet-4-6' },
    { key: 'm1:r1:1', t: Date.parse(T1), name: 'Read', detail: '/a.js', model: 'claude-sonnet-4-6' },
  ]);
});

test('an error row keeps the tool id and a text cut to 300 characters', async () => {
  const long = 'x'.repeat(500);
  const file = writeTranscript([
    { type: 'user', timestamp: T1, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: long }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ text: 'boom' }] }] } },
    { type: 'user', timestamp: T1, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'fine' }] } },
  ]);
  const rows = await extractFile(file);

  assert.strictEqual(rows.errors.length, 2);
  assert.deepStrictEqual(rows.errors[0], { toolUseId: 'toolu_1', t: Date.parse(T1), text: 'x'.repeat(300) });
  assert.deepStrictEqual(rows.errors[1], { toolUseId: 'toolu_2', t: null, text: 'boom' });
});

test('an edit row counts added and removed lines for the line sessionId', async () => {
  const file = writeTranscript([
    {
      type: 'user',
      timestamp: T1,
      sessionId: 's1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      toolUseResult: { structuredPatch: [{ lines: [' keep', '-old', '+new', '+newer'] }] },
    },
    { type: 'user', timestamp: T1, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] }, toolUseResult: { stdout: 'no patch' } },
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.edits, [{ toolUseId: 'toolu_1', t: Date.parse(T1), sessionId: 's1', added: 2, removed: 1 }]);
});

const typed = (text, extra = {}) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', sessionId: 's1', message: { content: text }, ...extra });

test('a typed prompt is a row with its uuid, or sessionId:timestamp when it has none', async () => {
  const file = writeTranscript([
    typed('first', { uuid: 'u1', timestamp: T0 }),
    typed('second', { timestamp: T1 }),
    typed('no timestamp'),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.prompts, [
    { id: 'u1', t: Date.parse(T0), sessionId: 's1' },
    { id: `s1:${T1}`, t: Date.parse(T1), sessionId: 's1' },
  ]);
  assert.strictEqual(rows.sessions.s1.firstPrompt, 'first');
});

test('session summaries: main-thread branches in first-seen order, newest branch, last title, highest cost', async () => {
  const file = writeTranscript([
    { type: 'user', sessionId: 's1', gitBranch: 'main', timestamp: T0, message: { content: [] } },
    { type: 'user', sessionId: 's1', gitBranch: 'feat', timestamp: T2, message: { content: [] } },
    { type: 'user', sessionId: 's1', gitBranch: 'main', timestamp: T1, message: { content: [] } },
    { type: 'user', sessionId: 's1', gitBranch: 'HEAD', isSidechain: true, timestamp: T2, message: { content: [] } },
    { type: 'ai-title', sessionId: 's1', aiTitle: 'First title' },
    { type: 'ai-title', sessionId: 's1', aiTitle: '  Last title ' },
    { type: 'cost-state', sessionId: 's1', totalCostUSD: 1.5 },
    { type: 'cost-state', sessionId: 's1', totalCostUSD: 0.5 },
  ]);
  const { s1 } = (await extractFile(file)).sessions;

  assert.deepStrictEqual(s1.branches, ['main', 'feat']);
  assert.deepStrictEqual(s1.newestBranch, { t: Date.parse(T2), branch: 'feat' });
  assert.strictEqual(s1.title, 'Last title');
  assert.strictEqual(s1.reportedCost, 1.5);
});

test('a line with no sessionId is filed under the transcript path', async () => {
  const file = writeTranscript([{ ...assistant(), sessionId: undefined }]);
  const rows = await extractFile(file);

  assert.strictEqual(rows.calls[0].sessionId, file);
});

test('minT and maxT span every row timestamp, and are null for a file with none', async () => {
  const file = writeTranscript([
    typed('hello', { uuid: 'u1', timestamp: T1 }),
    assistant({ ts: T0 }),
    { type: 'user', timestamp: T2, message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'e' }] } },
  ]);
  const rows = await extractFile(file);
  assert.strictEqual(rows.minT, Date.parse(T0));
  assert.strictEqual(rows.maxT, Date.parse(T2));

  const empty = await extractFile(writeTranscript([{ type: 'ai-title', sessionId: 's1', aiTitle: 't' }]));
  assert.strictEqual(empty.minT, null);
  assert.strictEqual(empty.maxT, null);
});

test('a file that cannot be read gives ok: false and no rows, and malformed lines are skipped', async () => {
  const missing = await extractFile(path.join(os.tmpdir(), 'cc-dash-extract-missing', 'none.jsonl'));
  assert.strictEqual(missing.ok, false);
  assert.deepStrictEqual(missing.calls, []);

  const rows = await extractFile(writeTranscript(['{not json', assistant()]));
  assert.strictEqual(rows.ok, true);
  assert.strictEqual(rows.calls.length, 1);
});

test('a line that is JSON but not an object is skipped, and null no longer throws', async () => {
  const withOdd = await extractFile(
    writeTranscript([assistant({ msg: 'm1', req: 'r1' }), 'null', '42', '"text"', 'true', '[]', assistant({ msg: 'm2', req: 'r2', ts: T1 })]),
  );
  const plain = await extractFile(writeTranscript([assistant({ msg: 'm1', req: 'r1' }), assistant({ msg: 'm2', req: 'r2', ts: T1 })]));

  assert.strictEqual(withOdd.ok, true);
  assert.strictEqual(withOdd.calls.length, 2);
  assert.deepStrictEqual(withOdd, plain);
});

test('the rows survive a JSON round trip unchanged', async () => {
  const file = writeTranscript([
    typed('hi', { uuid: 'u1', timestamp: T0, gitBranch: 'main' }),
    assistant({ content: [toolUse('t1', 'Bash', { command: 'ls' })], extra: { version: '2.1.0', attributionSkill: 'brainstorming' } }),
  ]);
  const rows = await extractFile(file);

  // rows.sessions has no prototype and JSON.parse returns a plain object, so the
  // expected value copies it into a plain object first.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), { ...rows, sessions: { ...rows.sessions } });
});

test('a sessionId named like an Object.prototype member is an ordinary session', async () => {
  const file = writeTranscript([
    '{"type":"user","sessionId":"__proto__","gitBranch":"main","timestamp":"' + T0 + '","message":{"content":[]}}',
    '{"type":"user","sessionId":"constructor","gitBranch":"feat","timestamp":"' + T1 + '","message":{"content":[]}}',
    { type: 'ai-title', sessionId: 'constructor', aiTitle: 'A title' },
  ]);
  const rows = await extractFile(file);

  assert.strictEqual(rows.ok, true);
  assert.deepStrictEqual(Object.keys(rows.sessions).sort(), ['__proto__', 'constructor']);
  assert.deepStrictEqual(rows.sessions.constructor.branches, ['feat']);
  assert.strictEqual(rows.sessions.constructor.title, 'A title');
  assert.strictEqual(Object.getPrototypeOf(rows.sessions), null);
  assert.strictEqual({}.branches, undefined);
  assert.strictEqual(Object.keys(Object.prototype).length, 0);
});

// The warning prints once per process, so each case extracts in a fresh child
// process and returns what it printed on stderr.
function extractInChild(files) {
  const script = `const { extractFile } = require('./lib/extract');
    (async () => { for (const f of ${JSON.stringify(files)}) await extractFile(f); })();`;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  return out.stderr;
}

// Recent, because only lines from the last 7 days count toward the warning.
const untagged = (text) => ({ type: 'user', sessionId: 's1', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const typedPrompt = (text) => ({ ...untagged(text), origin: { kind: 'human' }, promptSource: 'typed' });

test('a file whose prompts carry no origin prints one warning, once per process', () => {
  const first = writeTranscript([untagged('hello'), assistant()]);
  const second = writeTranscript([untagged('again')]);
  const stderr = extractInChild([first, second]);
  assert.strictEqual(stderr.match(/\[extract\]/g)?.length, 1, stderr);
  assert.ok(stderr.includes(`[extract] ${first} has user prompts without origin or promptSource. Prompt counts and session reviews leave them out.`), stderr);
});

test('subagent task prompts, commands and meta lines print nothing', () => {
  const file = writeTranscript([
    { ...untagged('do the task'), origin: null, isSidechain: true },
    untagged('<command-name>/clear</command-name>'),
    { ...untagged('caveat'), isMeta: true },
    { ...untagged('sidechain without origin'), isSidechain: true },
  ]);
  assert.strictEqual(extractInChild([file]), '');
});

test('a file with a typed prompt prints nothing, even beside an untagged line', () => {
  const file = writeTranscript([typedPrompt('typed'), untagged('untagged')]);
  assert.strictEqual(extractInChild([file]), '');
});

test('a claude -p line (promptSource sdk, no origin) prints nothing', () => {
  const file = writeTranscript([{ ...untagged('hi'), entrypoint: 'sdk-cli', promptSource: 'sdk', turnOrigin: 'sdk' }]);
  assert.strictEqual(extractInChild([file]), '');
});

test('a compact summary prints nothing', () => {
  const file = writeTranscript([{ ...untagged('summary'), isCompactSummary: true }]);
  assert.strictEqual(extractInChild([file]), '');
});

test('an untagged line 30 days old prints nothing', () => {
  const file = writeTranscript([{ ...untagged('old'), timestamp: new Date(Date.now() - 30 * 86400000).toISOString() }]);
  assert.strictEqual(extractInChild([file]), '');
});

test('an untagged line with no timestamp prints nothing', () => {
  const { timestamp, ...line } = untagged('no time');
  const file = writeTranscript([line]);
  assert.strictEqual(extractInChild([file]), '');
});

test('the warning adds nothing to the extracted rows', async (t) => {
  t.mock.method(console, 'warn', () => {}); // this process's one warning, kept off the test output
  const file = writeTranscript([untagged('hello')]);
  const rows = await extractFile(file);
  assert.deepStrictEqual(rows.prompts, []);
  assert.strictEqual(EXTRACT_VERSION, 3);
});

test('a slash command line is a command row with its name, keyed like a prompt row', async () => {
  const file = writeTranscript([
    typed('<command-message>handoff</command-message>\n<command-name>/handoff</command-name>', { uuid: 'u1', timestamp: T0 }),
    typed('<command-name>/clear</command-name>\n<command-message>clear</command-message>', { timestamp: T1 }),
    typed('<command-name>/compact</command-name>'), // no timestamp
    typed('<command-message>x</command-message>', { uuid: 'u3', timestamp: T2 }), // no command-name
    typed('<command-name>/handoff</command-name>', { uuid: 'u4', timestamp: T2, isMeta: true }),
    typed('a prompt that quotes <command-name>/handoff</command-name> later on', { uuid: 'u2', timestamp: T2 }),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.commands, [
    { id: 'u1', t: Date.parse(T0), name: 'handoff' },
    { id: `s1:${T1}`, t: Date.parse(T1), name: 'clear' },
  ]);
  assert.deepStrictEqual(rows.prompts.map((p) => p.id), ['u2'], 'a prompt that only quotes a command is still a prompt');
});
