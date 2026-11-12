'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { addTask } = require('../lib/orchestrations/claims');

const BIN = path.join(__dirname, '..', 'bin', 'orch-claim');
const NO_TASK = 'NO TASK: the work queue is empty. Report that and stop.\n';

function claim(args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input });
}
function runIn(t) {
  return path.join(tmpDir(t, 'orch-claim'), 'img.run');
}
function task(n) {
  return {
    kind: 'work', task: n, title: 'Parse the field', plan: '/p/plan.md', worktree: `/wt/t${n}`, branch: `b-t${n}`,
    files: ['lib/a.js'], doneWhen: 'node --test test/a.test.js passes', sections: [], attempt: 1,
  };
}
const input = (n, over = {}) => JSON.stringify({ ...task(n), ...over });

test('--add work reads a task from stdin and prints the file name', (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'work'], input(3));
  assert.equal(r.stdout, '0001-t3-a1.json\n');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(run, 'pending', 'work', '0001-t3-a1.json')));
});

test('--add refuses a task missing worktree, task, title, plan, files or doneWhen', (t) => {
  const run = runIn(t);
  for (const key of ['worktree', 'task', 'title', 'plan', 'files', 'doneWhen']) {
    const body = task(3);
    delete body[key];
    const r = claim([run, '--add', 'work'], JSON.stringify(body));
    assert.equal(r.status, 1, key);
    assert.match(r.stderr, /^orch-claim: /, key);
  }
  assert.equal(fs.existsSync(path.join(run, 'pending', 'work')) && fs.readdirSync(path.join(run, 'pending', 'work')).length, false);
});

test('--add refuses malformed JSON', (t) => {
  const r = claim([runIn(t), '--add', 'work'], '{');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: /);
});

test('--add review refuses a task without implementer.transcript', (t) => {
  const run = runIn(t);
  assert.equal(claim([run, '--add', 'review'], input(3)).status, 1);
  const ok = claim([run, '--add', 'review'], input(3, { implementer: { agentId: 'a1', transcript: '/t/a.jsonl' } }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'pending', 'review', ok.stdout.trim()), 'utf8')).kind, 'review');
});

test('--add accepts task 0 with notes, and sets attempt to 1 when absent', (t) => {
  const run = runIn(t);
  const body = task(0);
  delete body.attempt;
  const r = claim([run, '--add', 'work'], JSON.stringify({ ...body, notes: 'fix shared code' }));
  assert.equal(r.stdout, '0001-t0-a1.json\n');
});

test('<run> work prints the claim', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(3));
  const r = claim([run, 'work']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('CLAIMED 0001-t3-a1.json\n'), r.stdout);
  assert.ok(r.stdout.includes('Your worktree is /wt/t3'));
});

test('<run> work on an empty queue prints the empty line and exits 0', (t) => {
  const r = claim([runIn(t), 'work']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, NO_TASK);
});

test('--release <file> returns a claimed task to pending', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(3));
  claim([run, 'work']);
  const r = claim([run, '--release', '0001-t3-a1.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(run, 'pending', 'work', '0001-t3-a1.json')));
  assert.equal(fs.existsSync(path.join(run, 'claimed', '0001-t3-a1.json')), false);
});

test('--status prints pending files and claimed files with no time', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(3));
  addTask(run, 'work', task(4));
  claim([run, 'work']);
  const r = claim([run, '--status']);
  assert.equal(r.stdout, 'work: 0002-t4-a1.json\nreview: (none)\nclaimed, no time: (none)\n');
});

test('eight claimers started at once for three tasks claim each task exactly once', async (t) => {
  const run = runIn(t);
  for (const n of [1, 2, 3]) addTask(run, 'work', task(n));
  const runs = Array.from({ length: 8 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, run, 'work']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  }));
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.code === 0));
  const claimed = results.filter((r) => r.out.startsWith('CLAIMED ')).map((r) => r.out.split('\n')[0]).sort();
  assert.deepEqual(claimed, ['CLAIMED 0001-t1-a1.json', 'CLAIMED 0002-t2-a1.json', 'CLAIMED 0003-t3-a1.json']);
  assert.equal(results.filter((r) => r.out === NO_TASK).length, 5);
  assert.equal(fs.readdirSync(path.join(run, 'claimed')).length, 3);
  assert.deepEqual(fs.readdirSync(path.join(run, 'pending', 'work')), []);
});

test('bad usage exits 1 with orch-claim: on stderr', (t) => {
  const run = runIn(t);
  for (const args of [[], [run], [run, 'other'], [run, '--release', '../x.json'], [run, '--add', 'other'], ['/tmp/img', 'work'], ['rel.run', 'work']]) {
    const r = claim(args, '');
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^orch-claim: /, args.join(' '));
  }
});

test('--add refuses an attempt that is not an integer >= 1 and leaves the queue empty', (t) => {
  const run = runIn(t);
  for (const attempt of ['two', 0, -1, 1.5, null]) {
    const r = claim([run, '--add', 'work'], input(1, { attempt }));
    assert.equal(r.status, 1, String(attempt));
    assert.match(r.stderr, /^orch-claim: task\.attempt/, String(attempt));
  }
  assert.equal(fs.existsSync(path.join(run, 'pending', 'work')), false);
  assert.equal(claim([run, '--add', 'work'], input(1, { attempt: 2 })).stdout, '0001-t1-a2.json\n');
});

test('--add refuses an empty files list', (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'work'], input(0, { files: [] }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: task\.files must be a non-empty array/);
});
