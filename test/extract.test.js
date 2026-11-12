'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { lineRows } = require('../lib/lines');
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
    { key: 'toolu_1', t: Date.parse(T1), name: 'Bash', detail: 'git', model: 'claude-sonnet-4-6', group: 'git status' },
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

  assert.deepStrictEqual(rows.edits, [{ toolUseId: 'toolu_1', t: Date.parse(T1), sessionId: 's1', added: 2, removed: 1, repo: null, file: null, root: null }]);
});

test('an edit row carries the repo of the edited file, and falls back to cwd only without a filePath', async () => {
  const root = fs.realpathSync(helpers.tmpDir(null, 'extract-repo'));
  const app = path.join(root, 'app');
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(app, '.git'), { recursive: true });
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  const result = (id, extra) => ({
    type: 'user', timestamp: T1, sessionId: 's1', cwd: other,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult: { structuredPatch: [{ lines: ['+a'] }], ...extra },
  });
  const file = writeTranscript([
    result('toolu_1', { filePath: path.join(app, 'src', 'a.js') }),
    result('toolu_2', {}),
    result('toolu_3', { filePath: path.join(root, 'loose.txt') }),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.edits.map((e) => e.repo), [app, other, null]);
});

// An Edit result for `filePath`, one added line.
const editAt = (id, filePath) => ({
  type: 'user', timestamp: T1, sessionId: 's1',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult: { structuredPatch: [{ lines: ['+a'] }], filePath },
});

test('no edit row for a scratchpad file, a memory file or the global CLAUDE.md', async () => {
  const root = fs.realpathSync(helpers.tmpDir(null, 'extract-excluded'));
  const folder = path.join(root, 'cfg', 'projects', '-x');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 's.jsonl');
  const lines = [
    editAt('toolu_1', path.join(root, 'tmp', 'claude-502', '-x', 'sid', 'scratchpad', 'plan.md')),
    editAt('toolu_2', path.join(folder, 'memory', 'MEMORY.md')),
    editAt('toolu_3', path.join(root, 'cfg', 'CLAUDE.md')),
    editAt('toolu_4', path.join(root, 'code', 'app', 'CLAUDE.md')),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.edits.map((e) => e.toolUseId), ['toolu_4']);
});

test('a transcript outside any projects folder still drops scratchpad edits', async () => {
  const file = writeTranscript([
    editAt('toolu_1', '/private/tmp/claude-502/-x/sid/scratchpad/plan.md'),
    editAt('toolu_2', '/private/tmp/claude-502/-x/sid/other/plan.md'),
    editAt('toolu_3', '/u/.claude/CLAUDE.md'),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.edits.map((e) => e.toolUseId), ['toolu_2', 'toolu_3']);
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

test('a typed prompt with a pasted image counts, titles the session with its text, and its isMeta image companion does not count', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const file = writeTranscript([
    typed([{ type: 'text', text: 'seeing a lot of these errors in logs - investigate [Image #3]' }, image], { uuid: 'u1', timestamp: T0 }),
    typed([{ type: 'text', text: '[Image: source: /tmp/3.png]' }], { uuid: 'u2', timestamp: T1, isMeta: true, turnCompanion: true }),
    { type: 'user', sessionId: 's1', uuid: 'u3', timestamp: T2, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.prompts, [{ id: 'u1', t: Date.parse(T0), sessionId: 's1' }]);
  assert.strictEqual(rows.sessions.s1.firstPrompt, 'seeing a lot of these errors in logs - investigate [Image #3]');
});

const midTurn = (prompt, extra = {}, attachment = {}) => ({
  type: 'attachment',
  isSidechain: false,
  sessionId: 's1',
  attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true, prompt, ...attachment },
  ...extra,
});

test('a prompt typed mid-turn (queued_command attachment) counts, as a string or text and image array, and is the first prompt when it comes first', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const file = writeTranscript([
    midTurn('first typed mid-turn', { uuid: 'u1', timestamp: T0 }),
    midTurn([{ type: 'text', text: 'second [Image #7]' }, image], { uuid: 'u2', timestamp: T1 }),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.prompts, [
    { id: 'u1', t: Date.parse(T0), sessionId: 's1' },
    { id: 'u2', t: Date.parse(T1), sessionId: 's1' },
  ]);
  assert.strictEqual(rows.sessions.s1.firstPrompt, 'first typed mid-turn');
});

test('a task-notification, a peer hand-back with isMeta and a sidechain queued_command attachment do not count', async () => {
  const file = writeTranscript([
    midTurn('<task-notification>done</task-notification>', { uuid: 'u1', timestamp: T0 }, { commandMode: 'task-notification' }),
    midTurn('subagent result', { uuid: 'u2', timestamp: T1 }, { origin: { kind: 'peer' }, isMeta: true }),
    midTurn('sidechain', { uuid: 'u3', timestamp: T2, isSidechain: true }),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.prompts, []);
});

// A forked skill (a /skill typed by the user) is written with origin human and no promptSource key.
const forked = (text, extra = {}) => ({ type: 'user', origin: { kind: 'human' }, sessionId: 's1', message: { content: text }, ...extra });

test('a forked-skill line (origin human, no promptSource, starts with /) is a typed prompt and the first prompt', async () => {
  const file = writeTranscript([forked('/code-review xhigh - https://github.com/x/y/pull/305', { uuid: 'u1', timestamp: T0 })]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.prompts, [{ id: 'u1', t: Date.parse(T0), sessionId: 's1' }]);
  assert.strictEqual(rows.sessions.s1.firstPrompt, '/code-review xhigh - https://github.com/x/y/pull/305');
});

test('a slash-looking line without a human typed tag is not a prompt', async () => {
  const file = writeTranscript([
    forked('<command-name>/clear</command-name>\n<command-message>clear</command-message>', { uuid: 'u1', timestamp: T0 }),
    forked('/foo', { uuid: 'u2', timestamp: T1, promptSource: 'sdk' }),
    forked('/foo', { uuid: 'u3', timestamp: T2, origin: undefined }),
  ]);
  const rows = await extractFile(file);

  assert.deepStrictEqual(rows.prompts, []);
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

test('an untagged prompt with text and image content prints the warning', () => {
  const file = writeTranscript([{ ...untagged('x'), message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } }]);
  assert.ok(extractInChild([file]).includes('[extract]'));
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

test('EXTRACT_VERSION is 17', () => {
  assert.strictEqual(EXTRACT_VERSION, 17);
});

function toolResultLine({ id = 'toolu_1', content = 'hello', agentId = null, min = 1 } = {}) {
  return {
    type: 'user', sessionId: 's1', timestamp: atMin(min), uuid: `u-${id}`,
    ...(agentId ? { agentId, isSidechain: true } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

test('every tool_result becomes a result row with the length of its text', async () => {
  const rows = await extractFile(writeTranscript([
    toolResultLine({ id: 'toolu_1', content: 'hello' }),
    toolResultLine({ id: 'toolu_2', content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }], agentId: 'a7' }),
  ]));
  assert.deepStrictEqual(rows.results, [
    { toolUseId: 'toolu_1', t: Date.parse(atMin(1)), sessionId: 's1', chars: 5 },
    { toolUseId: 'toolu_2', t: Date.parse(atMin(1)), sessionId: 's1', chars: 6, agentId: 'a7' },
  ]);
});

test('a main-thread turn_duration line becomes a turn row', async () => {
  const line = { type: 'system', subtype: 'turn_duration', durationMs: 30_800, messageCount: 495, timestamp: atMin(5), uuid: 'td1', sessionId: 's1', isSidechain: false };
  const rows = await extractFile(writeTranscript([line]));
  assert.deepStrictEqual(rows.turns, [{ id: 'td1', t: Date.parse(atMin(5)), sessionId: 's1', durationMs: 30_800 }]);
  assert.strictEqual(rows.maxT, Date.parse(atMin(5)));
});

test('a turn_duration line on a sidechain or without a duration adds no turn', async () => {
  const base = { type: 'system', subtype: 'turn_duration', timestamp: atMin(5), sessionId: 's1' };
  const rows = await extractFile(writeTranscript([
    { ...base, uuid: 'a', durationMs: 10, isSidechain: true },
    { ...base, uuid: 'b' },
    { ...base, uuid: 'c', durationMs: -1 },
  ]));
  assert.deepStrictEqual(rows.turns, []);
  assert.deepStrictEqual(rows.calls, []);
});

test('a Bash tool use carries its command group and a Read does not', async () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const line = (id, name, input) => ({
    type: 'assistant', sessionId: 's1', timestamp: atMin(0), requestId: `r-${id}`,
    message: { id: `m-${id}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id, name, input }] },
  });
  const rows = await extractFile(writeTranscript([
    line('toolu_b', 'Bash', { command: 'cd /r && sed -n 1,9p a.js' }),
    line('toolu_r', 'Read', { file_path: '/r/a.js' }),
  ]));
  const [bash, read] = rows.toolUses;
  assert.strictEqual(bash.group, 'sed -n');
  assert.strictEqual(bash.detail, 'sed');
  assert.strictEqual('group' in read, false);
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

// A handoff pickup: the typed resume prompt, a Read tool_use, and its tool_result.
const HANDOFF_FILE = '/Users/me/code/app/.claude/handoffs/2026-09-08-142310-feat-auth-refresh.md';
const handoffLines = ({ prompt, readPath = HANDOFF_FILE, result }) => [
  typed(prompt, { timestamp: T0 }),
  { type: 'assistant', sessionId: 's1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: readPath } }] } },
  { type: 'user', sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result }] } },
];
const HANDOFF_TEXT = '     1\t# Handoff: Fix the deploy failure (PR #319 open)\n     2\t\n     3\t## Status';

test('a mod-style resume prompt takes its title from the handoff heading, shortened', async () => {
  const prompt = `Read ${HANDOFF_FILE}, check Preconditions, then continue from "Next steps".`;
  const rows = await extractFile(writeTranscript(handoffLines({ prompt, result: HANDOFF_TEXT })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, 'Fix the deploy failure');
});

test('an image resume prompt takes its title from the Context image heading', async () => {
  const file = '/Users/me/code/app/.claude/context-images/2026-11-10-120000-main.md';
  const prompt = `Read ${file} in full, then every file it lists under "Read before starting". Continue from "Next steps".`;
  const result = '     1\t# Context image: Fix the login redirect\n     2\t\n     3\t## Sources';
  const rows = await extractFile(writeTranscript(handoffLines({ prompt, readPath: file, result })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, 'Fix the login redirect');
});

test('a skill-style relative resume prompt matches the absolute Read path', async () => {
  const prompt = 'Read .claude/handoffs/2026-09-08-142310-feat-auth-refresh.md, check Preconditions, then continue.';
  const rows = await extractFile(writeTranscript(handoffLines({ prompt, result: HANDOFF_TEXT })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, 'Fix the deploy failure');
});

test('a tool_result given as an array of text blocks is read', async () => {
  const prompt = `Read ${HANDOFF_FILE}, check Preconditions`;
  const result = [{ type: 'text', text: HANDOFF_TEXT }];
  const rows = await extractFile(writeTranscript(handoffLines({ prompt, result })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, 'Fix the deploy failure');
});

test('a Read of another file leaves handoffTitle null', async () => {
  const prompt = `Read ${HANDOFF_FILE}, check Preconditions`;
  const readPath = '/Users/me/code/app/.claude/handoffs/2026-01-01-000000-other.md';
  const rows = await extractFile(writeTranscript(handoffLines({ prompt, readPath, result: HANDOFF_TEXT })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, null);
});

test('a first prompt that is not a resume prompt leaves handoffTitle null even if a handoff is read later', async () => {
  const rows = await extractFile(writeTranscript(handoffLines({ prompt: 'fix the deploy', result: HANDOFF_TEXT })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, null);
});

test('a Bash cat of the handoff file, with an unprefixed result, gives the title', async () => {
  const prompt = `Read ${HANDOFF_FILE}, check Preconditions`;
  const lines = handoffLines({ prompt, result: '# Handoff: collapse the comment-rule stack (#316–#3\n\n## Status' });
  lines[1].message.content[0] = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `cat ${HANDOFF_FILE}` } };
  const rows = await extractFile(writeTranscript(lines));
  assert.strictEqual(rows.sessions.s1.handoffTitle, 'Collapse the comment-rule stack');
});

test('a Read result prefixed 1<tab> with no leading spaces gives the title', async () => {
  const prompt = `Read ${HANDOFF_FILE}, check Preconditions`;
  const rows = await extractFile(writeTranscript(handoffLines({ prompt, result: '1\t# Handoff: fix the deploy failure\n2\t' })));
  assert.strictEqual(rows.sessions.s1.handoffTitle, 'Fix the deploy failure');
});

// Sessions marked from the entrypoint field: 'sdk-cli' is claude -p, 'cli' is interactive.
const withEntrypoint = (entrypoint, text = 'hi') => ({ ...typedPrompt(text), ...(entrypoint ? { entrypoint } : {}) });

test('a session whose lines all carry entrypoint sdk-cli is non-interactive', async () => {
  const rows = await extractFile(writeTranscript([withEntrypoint('sdk-cli'), withEntrypoint('sdk-cli', 'again')]));
  assert.strictEqual(rows.sessions.s1.nonInteractive, true);
});

test('a session with entrypoint cli lines is interactive', async () => {
  const rows = await extractFile(writeTranscript([withEntrypoint('cli')]));
  assert.strictEqual(rows.sessions.s1.nonInteractive, false);
});

test('a session mixing cli and sdk-cli lines is interactive', async () => {
  const rows = await extractFile(writeTranscript([withEntrypoint('sdk-cli'), withEntrypoint('cli', 'later')]));
  assert.strictEqual(rows.sessions.s1.nonInteractive, false);
});

test('a session whose lines carry no entrypoint has no nonInteractive field', async () => {
  const rows = await extractFile(writeTranscript([withEntrypoint(null)]));
  assert.ok(!('nonInteractive' in rows.sessions.s1));
});

test('an unrecognised entrypoint does not decide the session', async () => {
  const rows = await extractFile(writeTranscript([withEntrypoint('vscode')]));
  assert.ok(!('nonInteractive' in rows.sessions.s1));
});

// Commit rows. A real repo is built, with a commit made between the Bash tool_use line
// (T0) and its tool_result line (T1).
const hasGit = spawnSync('git', ['--version']).status === 0;
const COMMIT_SECS = Date.parse(T0) / 1000 + 2;

function commitRepo(t, { commit = true } = {}) {
  const repo = fs.realpathSync(helpers.tmpDir(t, 'extract-commit'));
  const git = (args, secs) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `@${secs} +0000`, GIT_COMMITTER_DATE: `@${secs} +0000` };
    const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  git(['init', '-q', '-b', 'main'], 1);
  if (commit) {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\ny\nz\n');
    git(['add', '-A'], COMMIT_SECS);
    git(['commit', '-q', '-m', 'feat: x'], COMMIT_SECS);
  }
  return repo;
}

const commitCall = (command, extra = {}) => assistant({ ts: T0, content: [toolUse('toolu_c', 'Bash', { command })], extra: { sessionId: 's1', ...extra } });
const commitResult = (extra = {}, block = {}) => ({ type: 'user', timestamp: T1, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'ok', ...block }] }, ...extra });

test('extractFile records a commit row for a Bash git commit', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git commit -m "feat: x"`), commitResult()]));

  assert.strictEqual(rows.commits.length, 1);
  const { sha, parent, patchId, ...rest } = rows.commits[0];
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.match(patchId, /^[0-9a-f]{40}$/);
  assert.strictEqual(parent, null);
  assert.deepStrictEqual(rest, { added: 3, removed: 0, files: ['a.txt'], generated: [], amendOf: null, repo, toplevel: repo, amend: false, named: true, authorTime: COMMIT_SECS, authorEmail: 't@e.x', committerEmail: 't@e.x', subject: 'feat: x', toolUseId: 'toolu_c', t: Date.parse(T1), sessionId: 's1' });
});

test('extractFile uses the line cwd when the command has no cd', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall('git commit -m "feat: x"', { cwd: repo }), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
});

test('extractFile records no commit row when the commit call failed', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t, { commit: false });
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git commit -m "feat: x"`), commitResult({}, { is_error: true })]));
  assert.deepStrictEqual(rows.commits, []);
});

test('extractFile flags the row set when a git call is killed', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const file = writeTranscript([commitCall(`cd ${repo} && git commit -m "feat: x" # killed git`), commitResult()]);
  // A fake `git` that kills itself with SIGTERM gives the same error shape as a timeout.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegit-'));
  t.after(() => fs.rmSync(fakeDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fakeDir, 'git'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = fakeDir;
  let rows;
  try {
    rows = await extractFile(file);
  } finally {
    process.env.PATH = saved;
  }
  assert.deepStrictEqual(rows.commits, []);
  assert.strictEqual(rows.commitsIncomplete, true);
  const again = await extractFile(file);
  assert.strictEqual(again.commits.length, 1, 'a transient failure is not cached');
  assert.strictEqual(again.commitsIncomplete, undefined);
});

test('extractFile records no commit row before the result arrives', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git commit -m "feat: x"`)]));
  assert.deepStrictEqual(rows.commits, []);
});

test('an edit row carries the edited file path', async () => {
  const rows = await extractFile(writeTranscript([
    { type: 'user', timestamp: T1, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, toolUseResult: { filePath: '/a/b.js', structuredPatch: [{ lines: ['+new'] }] } },
  ]));
  assert.strictEqual(rows.edits[0].file, '/a/b.js');
});

test('extractFile resolves every repo a command committed to', { skip: !hasGit }, async (t) => {
  const a = commitRepo(t);
  const b = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${a} && git commit -m a && cd ${b} && git commit -m b`), commitResult()]));
  assert.deepStrictEqual(rows.commits.map((c) => c.toplevel).sort(), [a, b].sort());
});

const mergeCall = (repo, ts = T0) => assistant({ ts, msg: 'mm', req: 'rm', content: [toolUse('toolu_m', 'Bash', { command: `cd ${repo} && git merge --squash topic` })], extra: { sessionId: 's1' } });
const mergeResult = (block = {}, ts = T0) => ({ type: 'user', timestamp: ts, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: 'Squash commit -- not updating HEAD', ...block }] } });

test('a commit after merge --squash is marked squash', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult(), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.strictEqual(rows.commits[0].squash, true);
});

test('a commit in the same command as merge --squash is marked squash', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git merge --squash topic && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('a squash merge that stopped on a conflict still marks the commit', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult({ is_error: true, content: 'CONFLICT (content): Merge conflict in a.txt' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('a squash merge of a ref that does not exist marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult({ is_error: true, content: 'merge: nope - not something we can merge' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.ok(!('squash' in rows.commits[0]));
});

test('a squash merge refused for a dirty tree marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const text = 'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nPlease commit your changes or stash them before you merge.\nAborting';
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult({ is_error: true, content: text }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.ok(!('squash' in rows.commits[0]));
});

test('a squash merge followed by git merge --abort in the same command marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const call = assistant({ ts: T0, msg: 'mm', req: 'rm', content: [toolUse('toolu_m', 'Bash', { command: `cd ${repo} && git merge --squash topic || git merge --abort` })], extra: { sessionId: 's1' } });
  const rows = await extractFile(writeTranscript([call, mergeResult(), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.ok(!('squash' in rows.commits[0]));
});

const T_MID = '2026-10-01T10:00:02.000Z';
// A Bash call (id toolu_x) that runs `command` between the merge and the commit, with its result.
const otherCall = (command) => [
  assistant({ ts: T0, msg: 'mx', req: 'rx', content: [toolUse('toolu_x', 'Bash', { command })], extra: { sessionId: 's1' } }),
  { type: 'user', timestamp: T0, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } },
];

test('a squash that reports Already up to date marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult({ content: 'Already up to date.' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('a squash dropped by git merge --abort marks no later commit', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult({ is_error: true, content: 'CONFLICT' }), ...otherCall(`cd ${repo} && git merge --abort`), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('a squash dropped by git reset --hard marks no later commit', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult(), ...otherCall(`cd ${repo} && git reset --hard`), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('a squash is kept by commands that do not drop it', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult(), ...otherCall(`cd ${repo} && git status && git merge-base a b`), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('a commit that started before the squash is not marked', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const early = assistant({ ts: T0, msg: 'me', req: 're', content: [toolUse('toolu_c', 'Bash', { command: `cd ${repo} && git commit -m s` })], extra: { sessionId: 's1' } });
  const rows = await extractFile(writeTranscript([early, mergeCall(repo, T_MID), mergeResult({}, T_MID), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('a squash mark applies to one commit only', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const second = { ...commitCall(`cd ${repo} && git commit -m s`), uuid: 'u2' };
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult(), commitCall(`cd ${repo} && git commit -m s`), commitResult(), second, { ...commitResult(), timestamp: T2 }]));
  assert.strictEqual(rows.commits.filter((c) => c.squash).length, 1);
});

{
  const T_RESULT = '2026-10-01T10:00:01.000Z';
  const bgCall = (repo) => assistant({ ts: T0, content: [toolUse('toolu_c', 'Bash', { command: `cd ${repo} && git commit -m "feat: x"`, run_in_background: true })], extra: { sessionId: 's1' } });
  const launched = commitResult({}, { content: 'Command running in background' });
  const launchedEarly = { ...launched, timestamp: T_RESULT };
  const notice = (content) => ({ type: 'user', timestamp: T2, sessionId: 's1', message: { content } });
  const text = '<task-notification><tool-use-id>toolu_c</tool-use-id><status>completed</status></task-notification>';

  test('a background git commit is resolved at its task notification', { skip: !hasGit }, async (t) => {
    const repo = commitRepo(t);
    const rows = await extractFile(writeTranscript([bgCall(repo), launchedEarly, notice(text)]));
    assert.strictEqual(rows.commits.length, 1);
    assert.strictEqual(rows.commits[0].t, Date.parse(T2));
    assert.strictEqual(rows.commits[0].toolUseId, 'toolu_c');
  });

  test('a background git commit reads a notification made of text blocks', { skip: !hasGit }, async (t) => {
    const repo = commitRepo(t);
    const rows = await extractFile(writeTranscript([bgCall(repo), launchedEarly, notice([{ type: 'text', text }])]));
    assert.strictEqual(rows.commits.length, 1);
  });

  // A background call that failed to start (is_error on its result) committed nothing, so
  // its notification, if one arrives, creates no row.
  test('a background git commit whose result is an error makes no row', { skip: !hasGit }, async (t) => {
    const repo = commitRepo(t);
    const failedStart = { ...launchedEarly, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'spawn failed', is_error: true }] } };
    const rows = await extractFile(writeTranscript([bgCall(repo), failedStart, notice(text)]));
    assert.deepStrictEqual(rows.commits, []);
  });

  test('a background git commit with no notification makes no row', { skip: !hasGit }, async (t) => {
    const repo = commitRepo(t);
    const rows = await extractFile(writeTranscript([bgCall(repo), launchedEarly, notice('<tool-use-id>toolu_other</tool-use-id>')]));
    assert.deepStrictEqual(rows.commits, []);
  });
}

test('edit rows carry their checkout root', async (t) => {
  const root = fs.realpathSync(helpers.tmpDir(t, 'extract-root'));
  const wt = path.join(root, 'repo.wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nowhere/.git/worktrees/repo.wt\n');
  const file = path.join(wt, 'src', 'a.js');
  const rows = await extractFile(writeTranscript([
    { type: 'user', timestamp: T1, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, toolUseResult: { filePath: file, structuredPatch: [{ lines: ['+new'] }] } },
  ]));
  assert.strictEqual(rows.edits[0].root, wt);
});

test('a commit resolved through the removed-worktree fallback carries the worktree root', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const wt = `${repo}.wt`;
  const rows = await extractFile(writeTranscript([commitCall(`cd ${wt} && git commit -m "feat: x"`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.strictEqual(rows.commits[0].fallback, true);
  assert.strictEqual(rows.commits[0].root, wt);
});

// A repo whose HEAD reflog holds a real `git reset <mode> HEAD~1` inside the call window,
// then `commits` commits made after it (a.txt, b.txt ... each one file, subjects feat: 0 ...).
// markRerecord finds the reset in that reflog, so the call text alone does not mark a commit.
function resetRepo(t, { mode = '--soft', commits = 1 } = {}) {
  const repo = commitRepo(t, { commit: false });
  const git = (args, secs) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `@${secs} +0000`, GIT_COMMITTER_DATE: `@${secs} +0000` };
    const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  fs.writeFileSync(path.join(repo, 'base.txt'), 'x\n');
  git(['add', '-A'], 1);
  git(['commit', '-q', '-m', 'base'], 1);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\ny\nz\n');
  git(['add', '-A'], COMMIT_SECS - 1);
  git(['commit', '-q', '-m', 'prior work'], COMMIT_SECS - 1);
  git(['reset', '-q', mode, 'HEAD~1'], COMMIT_SECS - 1);
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(repo, i ? `b${i}.txt` : 'a.txt'), 'x\ny\nz\n');
    git(['add', '-A'], COMMIT_SECS);
    git(['commit', '-q', '-m', `feat: ${i}`], COMMIT_SECS);
  }
  return repo;
}

const softCall = (command) => assistant({ ts: T0, msg: 'mm', req: 'rm', content: [toolUse('toolu_m', 'Bash', { command })], extra: { sessionId: 's1' } });

test('a commit in the same command as git reset --soft is marked squash', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git reset --soft HEAD~1 && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('a later commit call after git reset --soft is marked squash', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const rows = await extractFile(writeTranscript([softCall(`cd ${repo} && git reset --soft HEAD~1`), mergeResult({ content: '' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('git reset --soft followed by git reset --hard in one command marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([softCall(`cd ${repo} && git reset --soft x && git reset --hard y`), mergeResult({ content: '' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('a git reset --soft whose result is an error marks no later commit', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const failed = mergeResult({ is_error: true, content: 'fatal: ambiguous argument HEAD~3: unknown revision or path not in the working tree.' });
  const rows = await extractFile(writeTranscript([softCall(`cd ${repo} && git reset --soft HEAD~3`), failed, commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(rows.commits.filter((c) => !c.fromReflog).length > 0);
  assert.ok(rows.commits.every((c) => !c.squash));
});

test('a command that holds a reset and a commit marks nothing when its result is an error', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git reset --soft HEAD~3 && git commit -m s`), commitResult({}, { is_error: true, content: 'fatal: bad revision' })]));
  assert.ok(rows.commits.filter((c) => !c.fromReflog).length > 0);
  assert.ok(rows.commits.every((c) => !c.squash));
});

const gitAt = (repo, args, secs) => {
  const env = { ...process.env, GIT_AUTHOR_DATE: `@${secs} +0000`, GIT_COMMITTER_DATE: `@${secs} +0000` };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
};
const callAt = (id, ts, command) => assistant({ ts, msg: `m${id}`, req: `r${id}`, content: [toolUse(id, 'Bash', { command })], extra: { sessionId: 's1' } });
const resultAt = (id, ts, block = {}) => ({ type: 'user', timestamp: ts, sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...block }] } });
const addedOf = (rows) => lineRows([], rows.commits).reduce((n, r) => n + r.added, 0);

test('a commit call that failed after committing still takes the re-record state of an earlier reset', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t, { commit: false });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'x\n');
  gitAt(repo, ['add', '-A'], 1);
  gitAt(repo, ['commit', '-q', '-m', 'base'], 1);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\nb\nc\nd\ne\n');
  gitAt(repo, ['add', '-A'], COMMIT_SECS - 102);
  gitAt(repo, ['commit', '-q', '-m', 'pre'], COMMIT_SECS - 102);
  gitAt(repo, ['reset', '-q', '--soft', 'HEAD~1'], COMMIT_SECS - 1);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\nb2\n');
  gitAt(repo, ['add', '-A'], COMMIT_SECS + 1);
  gitAt(repo, ['commit', '-q', '-m', 'redo'], COMMIT_SECS + 1);
  const rows = await extractFile(writeTranscript([
    callAt('pre', '2026-10-01T09:58:19.000Z', `cd ${repo} && git commit -m pre`), resultAt('pre', '2026-10-01T09:58:22.000Z'),
    callAt('rs', T0, `cd ${repo} && git reset --soft HEAD~1`), resultAt('rs', '2026-10-01T10:00:01.500Z', { content: '' }),
    callAt('c1', '2026-10-01T10:00:02.000Z', `cd ${repo} && git commit -m redo && git push`), resultAt('c1', T1, { is_error: true, content: 'error: failed to push some refs' }),
  ]));
  const redo = rows.commits.find((c) => c.subject === 'redo');
  assert.strictEqual(redo.squash, true);
  assert.deepStrictEqual(redo.rerecordDelta, { added: 2, removed: 0 });
  assert.strictEqual(addedOf(rows), 7);
});

test('a squash merge whose refusal text arrives with a success status marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([mergeCall(repo), mergeResult({ content: 'merge: nope - not something we can merge' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.ok(!('squash' in rows.commits[0]));
});

test('a one-command reword counts the original commit once, not the squash row', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t, { commit: false });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'x\n');
  gitAt(repo, ['add', '-A'], 1);
  gitAt(repo, ['commit', '-q', '-m', 'base'], 1);
  fs.writeFileSync(path.join(repo, 'z.txt'), Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n');
  gitAt(repo, ['add', '-A'], COMMIT_SECS - 1);
  gitAt(repo, ['commit', '-q', '-m', 'zero'], COMMIT_SECS - 1);
  gitAt(repo, ['reset', '-q', '--soft', 'HEAD~1'], COMMIT_SECS);
  gitAt(repo, ['commit', '-q', '-m', 'one'], COMMIT_SECS);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git commit -m zero && git reset --soft HEAD~1 && git commit -m one`), commitResult()]));
  assert.strictEqual(addedOf(rows), 10);
});

test('a merge --squash in a removed checkout still marks the next commit', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const wt = `${repo}.wt`;
  const rows = await extractFile(writeTranscript([mergeCall(wt), mergeResult(), commitCall(`cd ${wt} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].fallback, true);
  assert.strictEqual(rows.commits[0].squash, true);
});

test('git text quoted under an unresolved ${repo} path does not mark a commit in the enclosing checkout', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const quoted = `cd ${repo} && python3 - <<'EOF'\ncd \${b} && git merge --squash topic\ncd \${b} && git reset --soft HEAD~1\nEOF`;
  const rows = await extractFile(writeTranscript([callAt('q', T0, quoted), resultAt('q', '2026-10-01T10:00:01.000Z'), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.ok(!('squash' in rows.commits[0]));
});

test('git text in a heredoc body registers no squash', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const call = callAt('h', T0, `cd ${repo} && cat > notes.md <<'EOF'\ngit merge --squash topic\nEOF`);
  const rows = await extractFile(writeTranscript([call, resultAt('h', '2026-10-01T10:00:01.000Z'), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.ok(!('squash' in rows.commits[0]));
});

test('git reset text in a heredoc body creates no re-record state', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const call = callAt('h', T0, `cd ${repo} && python3 - <<'E'\ngit reset --soft HEAD~1\nE`);
  const rows = await extractFile(writeTranscript([call, resultAt('h', '2026-10-01T10:00:01.000Z'), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(rows.commits.filter((c) => !c.fromReflog).length > 0);
  assert.ok(rows.commits.every((c) => !c.squash));
});

test('git commit -F - with a heredoc message that quotes git merge --squash is a commit call with no squash', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git commit -F - <<'EOF'\nfeat: x\n\nbody with git merge --squash y\nEOF`), commitResult()]));
  assert.strictEqual(rows.commits.length, 1);
  assert.strictEqual(rows.commits[0].toplevel, repo);
  assert.ok(!('squash' in rows.commits[0]));
});

test('a rebase --exec call is a commit call and its amended copies are rewrite rows, while the heredoc that writes the script is not', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t, { commit: false });
  gitAt(repo, ['commit', '-q', '--allow-empty', '-m', 'base'], 1);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2\na3\n');
  gitAt(repo, ['add', '-A'], 100);
  gitAt(repo, ['commit', '-q', '-m', 'first work'], 100);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\nb2\n');
  gitAt(repo, ['add', '-A'], 101);
  gitAt(repo, ['commit', '-q', '-m', 'second work'], 101);
  const env = { ...process.env, GIT_COMMITTER_DATE: `@${COMMIT_SECS} +0000` };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', 'rebase', '-q', '--exec', 'git commit -q --amend --no-edit', 'HEAD~2'], { cwd: repo, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const write = callAt('w', '2026-10-01T09:59:00.000Z', `cd ${repo} && cat > strip.sh <<'EOF'\n#!/usr/bin/env bash\ngit log -1 --format=%B | git commit --amend --no-verify -F - -q\nEOF\nchmod +x strip.sh`);
  const rows = await extractFile(writeTranscript([
    write, resultAt('w', '2026-10-01T09:59:01.000Z'),
    callAt('rb', T0, `cd ${repo} && git rebase -q --exec "./strip.sh" HEAD~2`), resultAt('rb', T1),
  ]));
  assert.deepStrictEqual(rows.commits.map((c) => c.toolUseId), ['rb', 'rb']);
  assert.ok(rows.commits.every((c) => c.rewrite === true));
  assert.deepStrictEqual(rows.commits.map((c) => c.added).sort(), [2, 3]);
});

test('a reset --soft in a removed checkout counts the whole sequence as 0', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const wt = `${repo}.wt`;
  const rows = await extractFile(writeTranscript([callAt('rs', T0, `cd ${wt} && git reset --soft HEAD~2`), resultAt('rs', '2026-10-01T10:00:01.000Z', { content: '' }), commitCall(`cd ${wt} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
  assert.ok(!rows.commits[0].rerecordDelta);
  assert.strictEqual(addedOf(rows), 0);
});

test('every commit after a git reset that moved HEAD in one command is marked squash, an unstage in between included', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t, { commits: 2 });
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git reset -q --soft base && git reset -q && git add a && git commit -m one && git add b && git commit -m two`), commitResult()]));
  const after = rows.commits.filter((c) => !c.fromReflog);
  assert.strictEqual(after.length, 2);
  assert.ok(after.every((c) => c.squash === true));
});

test('git reset --soft HEAD~1 alone marks the next commit call', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const rows = await extractFile(writeTranscript([softCall(`cd ${repo} && git reset --soft HEAD~1`), mergeResult({ content: '' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('git reset HEAD -- f alone creates no state', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([softCall(`cd ${repo} && git reset HEAD -- a.txt`), mergeResult({ content: '' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('a unstage after git reset --soft keeps the state for the next commit call', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t);
  const rows = await extractFile(writeTranscript([softCall(`cd ${repo} && git reset -q --soft base && git reset -q`), mergeResult({ content: '' }), commitCall(`cd ${repo} && git commit -m s`), commitResult()]));
  assert.strictEqual(rows.commits[0].squash, true);
});

test('git reset of an existing path is an unstage and marks nothing', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const rows = await extractFile(writeTranscript([commitCall(`cd ${repo} && git reset -q a.txt && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in rows.commits[0]));
});

test('git reset to a revision marks the commit after it, and a reset --soft with no rev marks nothing', { skip: !hasGit }, async (t) => {
  const repo = resetRepo(t, { mode: '--mixed' });
  const marked = await extractFile(writeTranscript([commitCall(`cd ${repo} && git reset -q HEAD~1 && git commit -m s`), commitResult()]));
  assert.strictEqual(marked.commits[0].squash, true);
  require('../lib/commits').resetCommitState();
  const plain = await extractFile(writeTranscript([commitCall(`cd ${repo} && git reset -q --soft && git commit -m s`), commitResult()]));
  assert.ok(!('squash' in plain.commits[0]));
});

// Counts git starts through a `git` shim first on PATH. Wrapping child_process.execFileSync
// would miss them, because lib/commits.js destructures it when it is required.
function withGitShim(t) {
  const dir = helpers.tmpDir(t, 'git-shim');
  const log = path.join(dir, 'calls.log');
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);
}

test('extractFile with commits: false returns the same calls, no commit rows, and starts no git', { skip: !hasGit }, async (t) => {
  const repo = commitRepo(t);
  const lines = [
    cached({ msg: 'a', write: 100 }),
    commitCall(`cd ${repo} && git commit -m "feat: x"`),
    commitResult(),
    callAt('rs', T0, `cd ${repo} && git reset main`),
    resultAt('rs', T1),
  ];
  const file = writeTranscript(lines);
  const spawned = withGitShim(t);
  require('../lib/commits').resetCommitState();

  const off = await extractFile(file, { commits: false });
  assert.strictEqual(spawned(), 0);
  assert.deepStrictEqual(off.commits, []);

  const on = await extractFile(file);
  assert.ok(spawned() > 0, 'the shim sees git starts when commits are on');
  assert.deepStrictEqual(off.calls, on.calls);
  assert.ok(off.calls.length > 0);
});
