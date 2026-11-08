'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'transcript-index');

function typed(text, i) {
  return JSON.stringify({
    type: 'user', uuid: `u${i}`, parentUuid: `p${i}`, sessionId: 's1', timestamp: '2026-11-08T10:00:00.000Z',
    origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text },
  });
}
function reply(text, i) {
  return JSON.stringify({
    type: 'assistant', uuid: `a${i}`, sessionId: 's1', timestamp: '2026-11-08T10:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/r/f${i}.ts` } }] },
  });
}

function transcript(t, lines) {
  const file = path.join(tmpDir(t, 'transcript-index'), 's1.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function run(input) {
  return spawnSync(process.execPath, [BIN], { input, encoding: 'utf8' });
}
function runArgs(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('stdin mode writes the index to out and prints nothing', (t) => {
  const T = transcript(t, [typed('hello', 1), reply('hi', 1)]);
  const dir = tmpDir(t, 'transcript-index-out');
  const out = path.join(dir, 'idx', 's1.md');
  const r = run(JSON.stringify({ transcript: T, out }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /^# Transcript index:/);
  assert.ok(md.includes('(2 lines)'), 'a final newline adds no line');
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['s1.md'], 'no temp file left behind');
});

test('stdin mode removes its temp file when the write fails', (t) => {
  const T = transcript(t, [typed('hello', 1), reply('hi', 1)]);
  const dir = path.join(tmpDir(t, 'transcript-index-out'), 'idx');
  // A folder where the index file should go makes the rename fail.
  fs.mkdirSync(path.join(dir, 's1.md'), { recursive: true });
  const r = run(JSON.stringify({ transcript: T, out: path.join(dir, 's1.md') }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^transcript-index: /);
  assert.deepEqual(fs.readdirSync(dir), ['s1.md']);
});

test('argv mode prints the index', (t) => {
  const T = transcript(t, [typed('hello', 1), reply('hi', 1)]);
  const r = runArgs([T]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# Transcript index:/);
});

test('stdin mode with a missing transcript exits 0 and writes nothing', (t) => {
  const dir = tmpDir(t, 'transcript-index-out');
  const out = path.join(dir, 'idx', 's1.md');
  const r = run(JSON.stringify({ transcript: '/nonexistent/abc.jsonl', out }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(out), false);
});

test('stdin mode exits 1 with a reason for stdin that is not JSON or lacks a path', () => {
  for (const input of ['not json', '', '{}', '{"transcript":"/a.jsonl"}', 'null']) {
    const r = run(input);
    assert.equal(r.status, 1, `stdin ${JSON.stringify(input)}`);
    assert.match(r.stderr, /^transcript-index: /, `stdin ${JSON.stringify(input)}`);
  }
});

test('argv mode with a missing file exits 1 with a message', () => {
  const r = runArgs(['/nonexistent/abc.jsonl']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^transcript-index: /);
  assert.equal(r.stdout, '');
});

test('indexes a 30,000-line transcript in under 10 seconds', (t) => {
  const lines = [];
  for (let i = 0; lines.length < 30_000; i++) {
    lines.push(typed(`prompt ${i} ${'x'.repeat(200)}`, i));
    for (let k = 0; k < 9; k++) lines.push(reply(`reply ${'y'.repeat(2_000)}`, `${i}-${k}`));
  }
  const T = transcript(t, lines);
  const out = path.join(tmpDir(t, 'transcript-index-out'), 's1.md');
  const start = Date.now();
  const r = run(JSON.stringify({ transcript: T, out }));
  const ms = Date.now() - start;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 10_000, `took ${ms} ms`);
  assert.ok(fs.readFileSync(out, 'utf8').includes('(30000 lines)'));
});

// An 8-line worker transcript, agent-a1.jsonl, with a meta file beside it unless
// meta is null. Two reads, a failed command, a coordinator message, an edit and a
// final text whose usage puts the context at 41,250 tokens.
function worker(t, meta) {
  const dir = tmpDir(t, 'transcript-index-worker');
  const at = (s) => ({ agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: `2026-11-08T14:02:${s}.000Z` });
  const user = (s, content, extra = {}) => JSON.stringify({ type: 'user', ...at(s), message: { role: 'user', content }, ...extra });
  const asst = (s, content, usage) => JSON.stringify({ type: 'assistant', ...at(s), message: { role: 'assistant', content, usage } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const lines = [
    user('00', 'Task 3: do it'),
    asst('01', [use('r1', 'Read', { file_path: '/r/spec.md' }), use('r2', 'Read', { file_path: '/r/a.ts' })]),
    user('02', [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }]),
    asst('02', [use('b1', 'Bash', { command: 'npm test' })], { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }),
    user('03', [{ type: 'tool_result', tool_use_id: 'b1', content: 'exit 1', is_error: true }]),
    user('05', 'The coordinator sent a message while you were working:\nStop after this.', { isMeta: true, origin: { kind: 'coordinator' } }),
    asst('09', [use('e1', 'Edit', { file_path: '/r/a.ts' })]),
    asst('11', [{ type: 'text', text: 'Done; tests pass.' }], { input_tokens: 1250, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }),
  ];
  const file = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (meta) fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify(meta));
  return file;
}

test('--steps prints the meta header, context, and the files read', (t) => {
  const file = worker(t, { agentType: 'general-purpose', description: 'Task 3', model: 'sonnet', spawnDepth: 1 });
  const r = runArgs([file, '--steps', '20']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Agent a1: "Task 3" \(general-purpose, sonnet\) · finished: no · context 41250 tokens · 8 lines · last activity 2026-11-08T14:02:11\.000Z\nRead: \/r\/spec\.md, \/r\/a\.ts\n\n/);
  assert.ok(r.stdout.endsWith('7 14:02:09 Edit /r/a.ts\n8 14:02:11 TEXT Done; tests pass.\n'), r.stdout);
});

test('--steps n prints only the last n steps', (t) => {
  const r = runArgs([worker(t, null), '--steps', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n\n')[1], '8 14:02:11 TEXT Done; tests pass.\n');
});

test('--steps with a meta file lacking model and finished says default model and finished: no', (t) => {
  const r = runArgs([worker(t, { agentType: 'general-purpose', description: 'Task 3' }), '--steps', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Agent a1: "Task 3" \(general-purpose, default model\) · finished: no · /);
  const done = runArgs([worker(t, { agentType: 'Explore', description: 'Map', model: 'sonnet', finished: true }), '--steps', '5']);
  assert.match(done.stdout, /^Agent a1: "Map" \(Explore, sonnet\) · finished: yes · /);
});

test('--steps with no meta file prints the file name header', (t) => {
  const r = runArgs([worker(t, null), '--steps', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^agent-a1\.jsonl · context 41250 tokens · 8 lines · last activity /);
});

test('--steps on a missing file says no transcript yet and exits 0', () => {
  const r = runArgs(['/nonexistent/agent-a1.jsonl', '--steps', '20']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'no transcript yet: /nonexistent/agent-a1.jsonl\n');
});

test('--steps without a positive count, or an unknown option, exits 1 with a message', (t) => {
  const file = worker(t, null);
  for (const args of [[file, '--steps', 'x'], [file, '--steps', '0'], [file, '--bogus']]) {
    const r = runArgs(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^transcript-index: /, args.join(' '));
  }
});

test('--help prints usage and exits 0', () => {
  const r = runArgs(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^usage: transcript-index/);
});
