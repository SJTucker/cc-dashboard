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
