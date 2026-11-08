'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { boardEvents } = require('../lib/transcript-index');

const POST = path.join(__dirname, '..', 'bin', 'board-post');
const INDEX = path.join(__dirname, '..', 'bin', 'transcript-index');

function post(args) {
  return spawnSync(process.execPath, [POST, ...args], { encoding: 'utf8' });
}

test('board-post appends one JSON line with time, from, title and body', (t) => {
  const board = path.join(tmpDir(t, 'board'), 'img.board.jsonl');
  assert.equal(post([board, '--from', 'Task 2', '--title', 'auth helper is broken', '--body', 'it\nthrows']).status, 0);
  const r = post([board, '--from', 'Task 3', '--title', 'x'.repeat(200), '--body', 'y'.repeat(3000)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const lines = fs.readFileSync(board, 'utf8').split('\n');
  assert.equal(lines.length, 3, 'two lines and a final newline');
  const first = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(first), ['t', 'from', 'title', 'body']);
  assert.ok(!Number.isNaN(Date.parse(first.t)));
  assert.deepEqual([first.from, first.title, first.body], ['Task 2', 'auth helper is broken', 'it\nthrows']);
  const second = JSON.parse(lines[1]);
  assert.equal(second.title.length, 120);
  assert.equal(second.body.length, 2000);
});

test('board-post without --body writes an empty body', (t) => {
  const board = path.join(tmpDir(t, 'board'), 'b.jsonl');
  assert.equal(post([board, '--from', 'Task 1', '--title', 'renamed foo to bar']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(board, 'utf8')).body, '');
});

test('board-post without --title exits 1 and writes nothing', (t) => {
  const board = path.join(tmpDir(t, 'board'), 'b.jsonl');
  for (const args of [[board, '--from', 'Task 1'], [board, '--title', 'x'], ['--from', 'a', '--title', 'b'], [board, '--from', 'a', '--title', '']]) {
    const r = post(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^board-post: /, args.join(' '));
  }
  assert.equal(fs.existsSync(board), false);
});

test('boardEvents reports only lines after seenLines, skipping invalid ones', () => {
  const text = [
    JSON.stringify({ t: '2026-11-08T14:00:00Z', from: 't1', title: 'seen already', body: '' }),
    JSON.stringify({ t: '2026-11-08T14:01:00Z', from: 't2', title: 'auth helper is broken', body: 'details' }),
    '{not json',
    '',
  ].join('\n');
  assert.deepEqual(boardEvents(text, 1), { events: ['POST t2: auth helper is broken'], seenLines: 3 });
});

test('boardEvents leaves a line with no newline yet for the next read', () => {
  const line = JSON.stringify({ t: 'x', from: 't2', title: 'half', body: '' });
  assert.deepEqual(boardEvents(line.slice(0, 20), 0), { events: [], seenLines: 0 });
  assert.deepEqual(boardEvents(line + '\n', 0), { events: ['POST t2: half'], seenLines: 1 });
});

test('--watch --board prints a POST line for a post made while it runs', async (t) => {
  const dir = tmpDir(t, 'board-watch');
  const board = path.join(dir, 'img.board.jsonl');
  post([board, '--from', 'Task 0', '--title', 'posted before the watch']);
  const at = (s) => ({ agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: `2026-11-08T14:02:${s}.000Z` });
  const file = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do task 2' } }) + '\n');
  const child = spawn(process.execPath, [INDEX, file, '--watch', '--board', board], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 500));
  post([board, '--from', 'Task 2', '--title', 'auth helper is broken']);
  await new Promise((r) => setTimeout(r, 2_500));
  const handback = { type: 'assistant', ...at('09'), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 'Report: done' } }] } };
  fs.appendFileSync(file, JSON.stringify(handback) + '\n');
  assert.equal(await exited, 0);
  assert.equal(stdout, 'POST Task 2: auth helper is broken\nDONE Report: done\n');
});
