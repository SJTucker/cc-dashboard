'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractFile, markRebuilds, REBUILD_MIN_TOKENS, EXTRACT_VERSION } = require('../lib/extract');

const ROOT = path.join(__dirname, '..');

// Writes one transcript from line objects and returns its path.
function writeTranscript(lines) {
  const dir = helpers.tmpDir(null, 'extract');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

// One assistant line with cache usage. `write` goes to the 5m or the 1h split.
const BASE = Date.parse('2026-10-01T10:00:00.000Z');
const atMin = (min) => new Date(BASE + min * 60_000).toISOString();
function cached({ min = 0, msg, write = 0, read = 0, ttl = '5m', model = 'claude-opus-5-5', reason, sidechain = false }) {
  const split = ttl === '1h'
    ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write }
    : { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 };
  const message = {
    id: msg,
    model,
    content: [],
    usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: split },
  };
  if (reason) message.diagnostics = { cache_miss_reason: { type: reason, cache_missed_input_tokens: write } };
  return { type: 'assistant', timestamp: atMin(min), sessionId: 's1', requestId: `r-${msg}`, ...(sidechain ? { isSidechain: true } : {}), message };
}

async function callsOf(lines) {
  return (await extractFile(writeTranscript(lines))).calls;
}

test('a call row carries Claude Code\'s cache miss reason only when it gave one', async () => {
  const calls = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 1, msg: 'b', write: 100_000, reason: 'tools_changed' })]);
  assert.strictEqual('missReason' in calls[0], false);
  assert.strictEqual(calls[1].missReason, 'tools_changed');
});

test('a reason on a later line of a response reaches the merged call row', async () => {
  const first = cached({ msg: 'a', write: 100_000 });
  const later = cached({ msg: 'a', write: 100_000, reason: 'tools_changed' });
  const calls = await callsOf([cached({ msg: 'z', write: 100_000 }), first, later]);
  assert.strictEqual(calls[1].missReason, 'tools_changed');
});

test('each cache_miss_reason type maps to a cause, and an unknown type to other', async () => {
  const table = [
    ['previous_message_not_found', 'expired'],
    ['messages_changed', 'messages'],
    ['tools_changed', 'tools'],
    ['system_changed', 'system'],
    ['model_changed', 'model'],
    ['unavailable', 'unavailable'],
    ['brand_new_reason', 'other'],
  ];
  for (const [reason, cause] of table) {
    const calls = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 1, msg: 'b', write: 100_000, reason })]);
    assert.deepStrictEqual(calls[1].rebuild, { cause, reason, tokens: 100_000, gapMs: 60_000 }, reason);
  }
});

test('a conversation\'s first call is never a rebuild', async () => {
  const [call] = await callsOf([cached({ msg: 'a', write: 100_000, reason: 'previous_message_not_found' })]);
  assert.strictEqual('rebuild' in call, false);
});

test('a cache write under REBUILD_MIN_TOKENS is not a rebuild, even with a reason', async () => {
  const calls = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 1, msg: 'b', write: REBUILD_MIN_TOKENS - 1, reason: 'unavailable' })]);
  assert.strictEqual('rebuild' in calls[1], false);
});

test('without a reason, a call is a rebuild only when its cache write is over 80% of its context', async () => {
  const small = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 10, msg: 'b', write: 50_000, read: 100_000 })]);
  assert.strictEqual('rebuild' in small[1], false);
  const big = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 10, msg: 'b', write: 100_000 })]);
  assert.strictEqual(big[1].rebuild.cause, 'expired');
});

test('without a reason, a gap past the 5-minute TTL is expired and a shorter one unknown', async () => {
  const late = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 6, msg: 'b', write: 100_000 })]);
  assert.deepStrictEqual(late[1].rebuild, { cause: 'expired', reason: null, tokens: 100_000, gapMs: 6 * 60_000 });
  const soon = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 4, msg: 'b', write: 100_000 })]);
  assert.strictEqual(soon[1].rebuild.cause, 'unknown');
});

test('a 1-hour cache write sets a 1-hour TTL, and a read-only call keeps the TTL', async () => {
  const within = await callsOf([cached({ msg: 'a', write: 100_000, ttl: '1h' }), cached({ min: 30, msg: 'b', write: 100_000 })]);
  assert.strictEqual(within[1].rebuild.cause, 'unknown');
  const past = await callsOf([
    cached({ msg: 'a', write: 100_000, ttl: '1h' }),
    cached({ min: 1, msg: 'b', read: 100_000 }),
    cached({ min: 62, msg: 'c', write: 100_000 }),
  ]);
  assert.strictEqual(past[2].rebuild.cause, 'expired');
});

test('without a reason, a model change is the cause', async () => {
  const calls = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 1, msg: 'b', write: 100_000, model: 'claude-sonnet-5' })]);
  assert.strictEqual(calls[1].rebuild.cause, 'model');
});

// extractFile applies no day cutoff, so the first call of a session's day still has
// the call before it, however long ago.
test('a call after a 12-hour gap is compared with the call before the gap', async () => {
  const calls = await callsOf([cached({ min: -120, msg: 'a', write: 100_000 }), cached({ min: 600, msg: 'b', write: 100_000 })]);
  assert.strictEqual(calls[1].rebuild.cause, 'expired');
  assert.strictEqual(calls[1].rebuild.gapMs, 720 * 60_000);
});

test('sidechain calls and main-thread calls are separate cache conversations', async () => {
  const calls = await callsOf([
    cached({ min: 0, msg: 'm1', write: 100_000 }),
    cached({ min: 1, msg: 's1', write: 100_000, sidechain: true }),
    cached({ min: 2, msg: 'm2', read: 100_000 }),
    cached({ min: 3, msg: 's2', read: 100_000, sidechain: true }),
    cached({ min: 4, msg: 'm3', write: 100_000, reason: 'messages_changed' }),
  ]);
  const flagged = calls.filter((c) => 'rebuild' in c);
  assert.deepStrictEqual(flagged.map((c) => [c.key, c.rebuild.gapMs]), [['m3:r-m3', 2 * 60_000]]);
});

test('the first call of a subagent file is not a rebuild', async () => {
  const calls = await callsOf([
    cached({ min: 0, msg: 's1', write: 100_000, sidechain: true }),
    cached({ min: 8, msg: 's2', write: 100_000, sidechain: true }),
  ]);
  assert.strictEqual('rebuild' in calls[0], false);
  assert.strictEqual(calls[1].rebuild.cause, 'expired');
});

const compactLine = (min, sidechain = false) => ({ type: 'system', subtype: 'compact_boundary', timestamp: atMin(min), sessionId: 's1', isSidechain: sidechain });

test('the first call after a compact_boundary starts a conversation and is not a rebuild', async () => {
  const calls = await callsOf([
    cached({ min: 0, msg: 'a', write: 100_000 }),
    compactLine(1),
    cached({ min: 2, msg: 'b', write: 100_000, reason: 'tools_changed' }),
  ]);
  assert.strictEqual('rebuild' in calls[1], false);
});

test('after a compaction the TTL is 5 minutes again and gapMs counts from the post-compaction call', async () => {
  const calls = await callsOf([
    cached({ min: 0, msg: 'a', write: 100_000, ttl: '1h' }),
    compactLine(1),
    cached({ min: 2, msg: 'b', write: 100_000 }),
    cached({ min: 10, msg: 'c', write: 100_000 }),
  ]);
  assert.strictEqual('rebuild' in calls[1], false);
  assert.deepStrictEqual(calls[2].rebuild, { cause: 'expired', reason: null, tokens: 100_000, gapMs: 8 * 60_000 });
});

test('a sidechain call after a main-thread compact_boundary is unaffected', async () => {
  const calls = await callsOf([
    cached({ min: 0, msg: 's1', write: 100_000, sidechain: true }),
    compactLine(1),
    cached({ min: 2, msg: 's2', write: 100_000, sidechain: true, reason: 'tools_changed' }),
  ]);
  assert.strictEqual(calls[1].rebuild.cause, 'tools');
});

test('a sidechain compact_boundary does not start a main-thread conversation', async () => {
  const calls = await callsOf([
    cached({ min: 0, msg: 'a', write: 100_000 }),
    compactLine(1, true),
    cached({ min: 2, msg: 'b', write: 100_000, reason: 'tools_changed' }),
  ]);
  assert.strictEqual(calls[1].rebuild.cause, 'tools');
});

test('extractFile does not return the compaction times', async () => {
  const result = await extractFile(writeTranscript([cached({ msg: 'a', write: 100_000 }), compactLine(1)]));
  assert.strictEqual('compactions' in result, false);
});

test('a cache write of exactly 80% of the context, with no reason, is not a rebuild', async () => {
  // input 5 + write 20_000 + read 5_000 - 5 = 25_000 context, so the write is 80%.
  const calls = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 10, msg: 'b', write: 20_000, read: 4_995 })]);
  assert.strictEqual('rebuild' in calls[1], false);
});

test('a cache_miss_reason decides the cause even when the model changed', async () => {
  const calls = await callsOf([cached({ msg: 'a', write: 100_000 }), cached({ min: 1, msg: 'b', write: 100_000, reason: 'tools_changed', model: 'claude-sonnet-5' })]);
  assert.strictEqual(calls[1].rebuild.cause, 'tools');
});

test('markRebuilds leaves the order of the calls array alone', () => {
  const row = (key, min) => ({ key, t: BASE + min * 60_000, sidechain: false, model: 'm', missReason: null, usage: { input_tokens: 0, cache_creation_input_tokens: 100_000 } });
  const calls = [row('b', 10), row('a', 0)];
  markRebuilds(calls);
  assert.deepStrictEqual(calls.map((c) => c.key), ['b', 'a']);
  assert.strictEqual(calls[0].rebuild.cause, 'expired');
});

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
    { key: 'm1:r1:0', t: Date.parse(T1), name: 'Read', detail: '/a.js', model: 'claude-sonnet-4-6' },
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

test('session recap: the last away_summary wins, the /config suffix is stripped, bad content is ignored', async () => {
  const away = (content) => ({ type: 'system', subtype: 'away_summary', sessionId: 's1', content });
  const file = writeTranscript([
    away('Goal was A. Next: B. (disable recaps in /config)'),
    away(' Goal was C. Next: say whether to commit. (disable recaps in /config)  '),
    away(42),
    away('   '),
    { type: 'system', subtype: 'other', sessionId: 's1', content: 'not a recap' },
  ]);
  const { s1 } = (await extractFile(file)).sessions;
  assert.strictEqual(s1.recap, 'Goal was C. Next: say whether to commit.');
  const none = (await extractFile(writeTranscript([{ type: 'ai-title', sessionId: 's2', aiTitle: 't' }]))).sessions.s2;
  assert.strictEqual(none.recap, null);
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

// One line of a subagent response. `stop` is the line's message.stop_reason; undefined leaves the key out.
function subLine({ msg = 'm1', out = 8, stop, agentId = 'a1', key = true }) {
  const message = { id: msg, model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 2, output_tokens: out, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 } };
  if (stop !== undefined) message.stop_reason = stop;
  return { type: 'assistant', timestamp: atMin(0), sessionId: 's1', isSidechain: true, agentId, ...(key ? { requestId: `r-${msg}` } : {}), message };
}

test('a response whose lines all have a null stop_reason is marked noFinal', async () => {
  const [row] = await callsOf([subLine({ stop: null, out: 5 }), subLine({ stop: null, out: 8 })]);
  assert.strictEqual(row.noFinal, true);
  assert.strictEqual(row.usage.output_tokens, 8);
});

test('a response whose lines have no stop_reason key is marked noFinal', async () => {
  const [row] = await callsOf([subLine({}), subLine({})]);
  assert.strictEqual(row.noFinal, true);
});

test('a response with a final line has no noFinal key', async () => {
  const [row] = await callsOf([subLine({ stop: null, out: 5 }), subLine({ stop: 'tool_use', out: 242 })]);
  assert.strictEqual('noFinal' in row, false);
  assert.strictEqual(row.usage.output_tokens, 242);
});

test('the final flag of one response does not carry over to the next', async () => {
  const rows = await callsOf([subLine({ msg: 'm1', stop: 'end_turn' }), subLine({ msg: 'm2', stop: null })]);
  assert.deepStrictEqual(rows.map((r) => 'noFinal' in r), [false, true]);
});

test('a call row carries the line\'s agentId when it has one', async () => {
  const [sub] = await callsOf([subLine({ stop: 'end_turn' })]);
  assert.strictEqual(sub.agentId, 'a1');
  const [main] = await callsOf([subLine({ stop: 'end_turn', agentId: null })]);
  assert.strictEqual('agentId' in main, false);
});

test('a line with no request id is counted on its own and never marked noFinal', async () => {
  const [row] = await callsOf([subLine({ stop: null, key: false })]);
  assert.strictEqual(row.key, null);
  assert.strictEqual('noFinal' in row, false);
});

test('extractFile reads a .json path as a step file', async () => {
  const dir = helpers.tmpDir(null, 'extract');
  const file = path.join(dir, 'a9.json');
  fs.writeFileSync(file, JSON.stringify({ agentId: 'a9', steps: [{ t: 1, model: 'm', input: 1, cacheWrite: 2, cacheRead: 3, output: 4, turnId: 't', index: 0 }] }));
  const rows = await extractFile(file);
  assert.strictEqual(rows.ok, true);
  assert.deepStrictEqual(rows.agentSteps, [{ agentId: 'a9', t: 1, model: 'm', input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }]);
});

test('EXTRACT_VERSION is 7', () => {
  assert.strictEqual(EXTRACT_VERSION, 7);
});

// Two tool_use blocks without an id, one per line as Claude Code writes them.
function idlessToolLines(extra) {
  const usage = (out) => ({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out });
  const line = (block, out, stop, more) => ({
    type: 'assistant', sessionId: 's1', timestamp: atMin(0), requestId: 'req_1', ...more,
    message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: usage(out), content: [block], ...(stop ? { stop_reason: 'tool_use' } : {}) },
  });
  return [
    line({ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }, 5, false, extra(0)),
    line({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, 9, true, extra(1)),
  ];
}

for (const [label, extra] of [['apiBlockIndex on each line', (i) => ({ apiBlockIndex: i })], ['no apiBlockIndex (per-response counter)', () => ({})]]) {
  test(`two id-less tool_use blocks on separate lines of one response get two keys: ${label}`, async () => {
    const rows = await extractFile(writeTranscript(idlessToolLines(extra)));
    assert.strictEqual(rows.calls.length, 1, 'one response');
    assert.deepStrictEqual(rows.calls[0].tools, ['Read', 'Bash']);
    assert.deepStrictEqual(rows.toolUses.map((u) => u.name), ['Read', 'Bash']);
    assert.strictEqual(new Set(rows.toolUses.map((u) => u.key)).size, 2, 'the keys differ');
    assert.ok(!('idlessUses' in rows));
  });
}
