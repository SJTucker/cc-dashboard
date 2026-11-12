'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tmpDir, gitRepo } = require('./helpers');

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

const HANDBACK = JSON.stringify({
  type: 'assistant', agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:12.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 'Report: done' } }] },
});

// Runs the script without blocking the test, and resolves with its exit code and
// stdout once it exits or is killed.
function start(args) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.on('exit', (status) => resolve({ status, stdout: () => stdout })));
  return { child, exited, stdout: () => stdout };
}
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

test('--watch on a finished worker prints DONE and exits 0', (t) => {
  const file = worker(t, null);
  fs.appendFileSync(file, HANDBACK + '\n');
  const r = spawnSync(process.execPath, [BIN, file, '--watch', '--files', '/r/b.ts', '--budget', '40000'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    'DRIFT edit outside task files: /r/a.ts',
    'BUDGET context 41250 tokens, over 40000',
    'DONE Report: done',
    '',
  ].join('\n'));
});

test('--watch on a killed worker prints KILLED and exits 0', (t) => {
  const file = path.join(tmpDir(t, 'transcript-index-killed'), 'agent-a1.jsonl');
  const rec = (o) => JSON.stringify({ agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:00.000Z', ...o });
  fs.writeFileSync(file, [
    rec({ type: 'user', message: { role: 'user', content: 'Do task 3' } }),
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'k1', name: 'Bash', input: { command: 'npm test' } }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'k1', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  ].join('\n') + '\n');
  const r = spawnSync(process.execPath, [BIN, file, '--watch'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'KILLED Bash npm test\n');
});

test('--watch prints DONE when the meta file says finished', (t) => {
  const file = worker(t, { agentType: 'general-purpose', description: 'Task 3', finished: true });
  const r = spawnSync(process.execPath, [BIN, file, '--watch'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.endsWith('DONE Done; tests pass.\n'), r.stdout);
});

test('--watch waits for a transcript that does not exist yet', async (t) => {
  const file = path.join(tmpDir(t, 'transcript-index-late'), 'agent-a1.jsonl');
  const w = start([file, '--watch']);
  t.after(() => w.child.kill());
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(w.child.exitCode, null, 'still waiting');
  const lines = fs.readFileSync(worker(t, null), 'utf8') + HANDBACK + '\n';
  fs.writeFileSync(file, lines);
  const { status } = await w.exited;
  assert.equal(status, 0);
  assert.ok(w.stdout().endsWith('DONE Report: done\n'), w.stdout());
});

test('--watch prints QUIET once per quiet stretch and ignores a line still being written', async (t) => {
  const file = worker(t, null);
  fs.appendFileSync(file, '{"type":"assist');
  // 0.02 minutes is 1.2 seconds.
  const w = start([file, '--watch', '--quiet-min', '0.02']);
  t.after(() => w.child.kill());
  assert.ok(await until(() => w.stdout().includes('QUIET'), 8_000), w.stdout());
  await new Promise((r) => setTimeout(r, 3_000));
  assert.equal(w.stdout(), 'QUIET no new lines for 0.02 min\n');
  fs.appendFileSync(file, HANDBACK.slice('{"type":"assist'.length) + '\n');
  const { status } = await w.exited;
  assert.equal(status, 0);
  assert.ok(w.stdout().endsWith('DONE Report: done\n'), w.stdout());
});

test('--watch with a bad --budget or --quiet-min exits 1', (t) => {
  const file = worker(t, null);
  for (const args of [['--budget', 'x'], ['--quiet-min', '0'], ['--files']]) {
    const r = runArgs([file, '--watch', ...args]);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^transcript-index: /);
  }
});

test('--watch --since-line skips events up to that line', (t) => {
  const file = worker(t, null);
  fs.appendFileSync(file, HANDBACK + '\n');
  const r = spawnSync(process.execPath, [BIN, file, '--watch', '--since-line', '6'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'DONE Report: done\n');
  assert.equal(runArgs([file, '--watch', '--since-line', '-1']).status, 1);
});

test('--steps --full prints whole steps', (t) => {
  const file = worker(t, null);
  const command = 'echo ' + 'y'.repeat(300);
  fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:12.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b9', name: 'Bash', input: { command } }] },
  }) + '\n');
  assert.ok(runArgs([file, '--steps', '1', '--full']).stdout.endsWith(`9 14:02:12 Bash ${command}\n`));
  assert.ok(!runArgs([file, '--steps', '1']).stdout.includes(command));
});

test('--full without --steps, and --steps with --watch, exit 1', (t) => {
  const file = worker(t, null);
  for (const args of [[file, '--full'], [file, '--steps', '5', '--watch']]) {
    const r = runArgs(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^transcript-index: /);
  }
});

test('--steps leaves a half-written last line out of the line count', (t) => {
  const file = worker(t, null);
  fs.appendFileSync(file, '{"type":"assist');
  assert.match(runArgs([file, '--steps', '1']).stdout, / · 8 lines · /);
});

test('--steps lists files read through Bash on the Read: line', (t) => {
  const file = worker(t, null);
  const notes = path.join(tmpDir(t, 'transcript-index-notes'), 'notes.md');
  fs.writeFileSync(notes, 'x\n');
  fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:12.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b9', name: 'Bash', input: { command: `grep -n x ${notes}` } }] },
  }) + '\n');
  assert.equal(runArgs([file, '--steps', '1']).stdout.split('\n')[1], `Read: /r/spec.md, /r/a.ts, ${notes}`);
});

// A worker transcript that edits /wt/lib/b.js, claims 0001-t3-a1.json (files lib/a.js)
// from a run folder, then edits /wt/lib/c.js, and hands back. extra lines go after the claim.
function claimWorker(t, { task = { files: ['lib/a.js'] }, extra = [] } = {}) {
  const dir = tmpDir(t, 'transcript-index-claim');
  const run = path.join(dir, 'img.run');
  fs.mkdirSync(path.join(run, 'claimed'), { recursive: true });
  if (task) fs.writeFileSync(path.join(run, 'claimed', '0001-t3-a1.json'), JSON.stringify(task));
  const rec = (o) => JSON.stringify({ agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:00.000Z', ...o });
  const asst = (content) => rec({ type: 'assistant', message: { role: 'assistant', content } });
  const res = (id, content) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const claim = (id, file) => [asst([use(id, 'Bash', { command: `/c/bin/orch-claim '${run}' work` })]), res(id, `CLAIMED ${file}\nYour worktree is /wt`)];
  const lines = [
    rec({ type: 'user', message: { role: 'user', content: 'Read the image' } }),
    asst([use('e1', 'Edit', { file_path: '/wt/lib/b.js' })]),
    ...claim('c1', '0001-t3-a1.json'),
    asst([use('e2', 'Edit', { file_path: '/wt/lib/c.js' })]),
    ...extra.flatMap((x) => claim(x.id, x.file)),
    HANDBACK,
  ];
  const file = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, run };
}
const watchRun = (file, ...args) => spawnSync(process.execPath, [BIN, file, '--watch', ...args], { encoding: 'utf8', timeout: 10_000 });

test('--watch --run reports DRIFT only for edits after the claim, against the claimed files', (t) => {
  const { file, run } = claimWorker(t);
  const r = watchRun(file, '--run', run);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('DRIFT edit outside task files: /wt/lib/c.js'), r.stdout);
  assert.ok(!r.stdout.includes('/wt/lib/b.js'), r.stdout);
});

test('--watch --run adds --files entries to the claimed files', (t) => {
  const { file, run } = claimWorker(t);
  const r = watchRun(file, '--run', run, '--files', '/wt/lib/c.js');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('DRIFT'), r.stdout);
});

test('--watch --run with an unreadable claim reports no DRIFT', (t) => {
  const { file, run } = claimWorker(t, { task: null });
  const r = watchRun(file, '--run', run);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('DRIFT'), r.stdout);
});

test('--watch --run prints CLAIM for a second claim', (t) => {
  const { file, run } = claimWorker(t, { extra: [{ id: 'c2', file: '0002-t4-a1.json' }] });
  const r = watchRun(file, '--run', run);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('CLAIM second claim 0002-t4-a1.json after 0001-t3-a1.json\n'), r.stdout);
});

test('--watch --run rejects a run folder that is not absolute, ends in .run and is normalized', (t) => {
  const { file } = claimWorker(t);
  for (const bad of ['rel/img.run', '/a/img', '/a/../a/img.run']) assert.equal(watchRun(file, '--run', bad).status, 1, bad);
});

test('--watch --run prints CLAIMED <file> task <N>: <title> once, and not again after the claim line on a re-armed watch', (t) => {
  const { file, run } = claimWorker(t, { task: { task: 3, title: 'Parse it', files: ['lib/a.js'] }, extra: [{ id: 'c2', file: '0002-t4-a1.json' }] });
  const r = watchRun(file, '--run', run);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('CLAIMED 0001-t3-a1.json task 3: Parse it\n').length, 2, r.stdout);
  assert.equal(r.stdout.split('CLAIMED').length, 2, r.stdout);
  const again = watchRun(file, '--run', run, '--since-line', '4');
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!again.stdout.includes('CLAIMED'), again.stdout);
});

test('--watch --run does not print CLAIMED when the claimed file cannot be read', (t) => {
  const { file, run } = claimWorker(t, { task: null });
  const r = watchRun(file, '--run', run);
  assert.ok(!r.stdout.includes('CLAIMED'), r.stdout);
});

test('--watch --run armed before the transcript exists follows lines appended across polls', async (t) => {
  const dir = tmpDir(t, 'transcript-index-late');
  const run = path.join(dir, 'img.run');
  fs.mkdirSync(path.join(run, 'claimed'), { recursive: true });
  fs.writeFileSync(path.join(run, 'claimed', '0001-t3-a1.json'), JSON.stringify({ task: 3, title: 'Parse it', files: ['lib/a.js'] }));
  const file = path.join(dir, 'agent-a1.jsonl');
  const rec = (o) => JSON.stringify({ agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:00.000Z', ...o });
  const asst = (content) => rec({ type: 'assistant', message: { role: 'assistant', content } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const claim = (id, f) => [asst([use(id, 'Bash', { command: `/c/bin/orch-claim '${run}' work` })]), rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `CLAIMED ${f}\nYour worktree is /wt` }] } })];
  const w = start([file, '--watch', '--run', run]);
  t.after(() => w.child.kill());
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(w.stdout(), '');
  const add = (lines) => fs.appendFileSync(file, lines.join('\n') + '\n');
  // An edit before the claim, then the claim.
  add([asst([use('e1', 'Edit', { file_path: '/wt/lib/b.js' })]), ...claim('c1', '0001-t3-a1.json')]);
  assert.ok(await until(() => w.stdout().includes('CLAIMED 0001-t3-a1.json task 3: Parse it\n'), 8_000), w.stdout());
  assert.ok(!w.stdout().includes('DRIFT'), w.stdout());
  // An edit outside the claimed files, then a second claim.
  add([asst([use('e2', 'Edit', { file_path: '/wt/lib/c.js' })])]);
  assert.ok(await until(() => w.stdout().includes('DRIFT edit outside task files: /wt/lib/c.js'), 8_000), w.stdout());
  add(claim('c2', '0002-t4-a1.json'));
  assert.ok(await until(() => w.stdout().includes('CLAIM second claim 0002-t4-a1.json after 0001-t3-a1.json\n'), 8_000), w.stdout());
  add([HANDBACK]);
  await w.exited;
  const out = w.stdout();
  assert.equal(out.split('CLAIMED ').length, 2, out);
  assert.equal(out.split('CLAIM second').length, 2, out);
  assert.equal(out.split('DRIFT').length, 2, out);
  assert.ok(!out.includes('/wt/lib/b.js'), out);
});

// A worker whose claimed task 3 (files: lib/a.js) has a real git repo as its worktree.
// lines() builds transcript lines; add() appends them to the transcript.
function gitWorker(t) {
  const repo = gitRepo(t);
  const dir = tmpDir(t, 'transcript-index-git');
  const run = path.join(dir, 'img.run');
  fs.mkdirSync(path.join(run, 'claimed'), { recursive: true });
  fs.writeFileSync(path.join(run, 'claimed', '0001-t3-a1.json'), JSON.stringify({ task: 3, title: 'Parse it', files: ['lib/a.js'], worktree: repo }));
  const file = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(file, '');
  const rec = (o) => JSON.stringify({ agentId: 'a1', isSidechain: true, sessionId: 's1', timestamp: '2026-11-08T14:02:00.000Z', ...o });
  const asst = (content) => rec({ type: 'assistant', message: { role: 'assistant', content } });
  const res = (id, content) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const lines = {
    claim: () => [asst([use('c1', 'Bash', { command: `/c/bin/orch-claim '${run}' work` })]), res('c1', `CLAIMED 0001-t3-a1.json\nYour worktree is ${repo}`)],
    bash: (id) => [asst([use(id, 'Bash', { command: "python3 - <<'E'\nopen('lib/c.js','w').write('c')\nE" })]), res(id, '')],
    edit: (id, p) => [asst([use(id, 'Edit', { file_path: p })]), res(id, 'ok')],
  };
  const add = (l) => fs.appendFileSync(file, l.join('\n') + '\n');
  return { repo, run, file, lines, add };
}

// Starts a watch on the gitWorker and waits for its CLAIMED line, which comes after the git base is taken.
async function watchClaimed(t, w, ...args) {
  const watch = start([w.file, '--watch', '--run', w.run, ...args]);
  t.after(() => watch.child.kill());
  w.add(w.lines.claim());
  assert.ok(await until(() => watch.stdout().includes('CLAIMED 0001-t3-a1.json task 3: Parse it\n'), 8_000), watch.stdout());
  return watch;
}

test('--watch --run reports DRIFT for a file a Bash command changed in the claimed worktree', async (t) => {
  const w = gitWorker(t);
  const watch = await watchClaimed(t, w);
  fs.writeFileSync(path.join(w.repo, 'lib/a.js'), 'changed');
  fs.writeFileSync(path.join(w.repo, 'lib/c.js'), 'c');
  w.add(w.lines.bash('b1'));
  const drift = `DRIFT edit outside task files: ${path.join(w.repo, 'lib/c.js')}\n`;
  assert.ok(await until(() => watch.stdout().includes(drift), 8_000), watch.stdout());
  w.add([HANDBACK]);
  await watch.exited;
  const out = watch.stdout();
  assert.equal(out.split('DRIFT').length, 2, out);
  assert.ok(!out.includes('lib/a.js'), out);
});

test('--watch --run reports a file once when both an Edit step and git show it', async (t) => {
  const w = gitWorker(t);
  const watch = await watchClaimed(t, w);
  const c = path.join(w.repo, 'lib/c.js');
  fs.writeFileSync(c, 'c');
  w.add(w.lines.edit('e1', c));
  w.add(w.lines.bash('b1'));
  w.add([HANDBACK]);
  await watch.exited;
  const out = watch.stdout();
  assert.equal(out.split(`DRIFT edit outside task files: ${c}\n`).length, 2, out);
  assert.equal(out.split('DRIFT').length, 2, out);
});

test('--watch --run keeps running to DONE when the worktree is removed', async (t) => {
  const w = gitWorker(t);
  const watch = await watchClaimed(t, w);
  fs.rmSync(w.repo, { recursive: true, force: true });
  w.add(w.lines.bash('b1'));
  w.add([HANDBACK]);
  const r = await watch.exited;
  assert.equal(r.status, 0);
  assert.ok(!r.stdout().includes('DRIFT'), r.stdout());
  assert.ok(r.stdout().endsWith('DONE Report: done\n'), r.stdout());
});

test('a re-armed --watch --run does not report changes already in the worktree when it started', async (t) => {
  const w = gitWorker(t);
  // The last watch saw lib/c.js change; it is still uncommitted when the new watch starts.
  fs.writeFileSync(path.join(w.repo, 'lib/c.js'), 'c');
  w.add([...w.lines.claim(), ...w.lines.bash('b1')]);
  const watch = start([w.file, '--watch', '--run', w.run, '--since-line', '4']);
  t.after(() => watch.child.kill());
  await new Promise((r) => setTimeout(r, 2_500));
  w.add(w.lines.bash('b2'));
  w.add([HANDBACK]);
  const r = await watch.exited;
  assert.ok(!r.stdout().includes('DRIFT'), r.stdout());
});

test('--watch with two transcript paths says to separate --files entries with commas', (t) => {
  const { file } = claimWorker(t);
  const r = watchRun(file, '--files', '/a.js', '/b.js');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /separate --files entries with commas/);
});

test('a re-armed --watch --run --since-line past the claim does not repeat CLAIM or CLAIMED', (t) => {
  const { file, run } = claimWorker(t, { task: { task: 3, title: 'Parse it', files: ['lib/a.js'] }, extra: [{ id: 'c2', file: '0002-t4-a1.json' }] });
  // Lines: 1 prompt, 2 edit, 3-4 claim, 5 edit, 6-7 second claim, 8 handback.
  const r = watchRun(file, '--run', run, '--since-line', '7');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('CLAIM'), r.stdout);
  assert.ok(r.stdout.endsWith('DONE Report: done\n'), r.stdout);
});
