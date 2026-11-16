'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { addTask, formatClaim } = require('../lib/orchestrations/claims');
const { planSections } = require('../lib/orchestrations/plan-sections');

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
  const empty = claim([run, '--add', 'review'], input(3, { implementer: { agentId: 'a1', transcript: '' } }));
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /implementer\.transcript/);
  assert.equal(fs.existsSync(path.join(run, 'pending', 'review')) && fs.readdirSync(path.join(run, 'pending', 'review')).length, false);
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
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(run, 'pending', 'work', '0001-t0-a1.json'), 'utf8'));
  assert.equal(written.attempt, 1);
  assert.equal(written.notes, 'fix shared code');
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

test('--add refuses a title with a shell-special character or a newline', (t) => {
  const run = runIn(t);
  for (const title of ['Fix "x"', 'Add `title`', 'Cost $5', 'Fix a\\b', 'Fix\nx']) {
    const r = claim([run, '--add', 'work'], input(1, { title }));
    assert.equal(r.status, 1, JSON.stringify(title));
    assert.ok(r.stderr.includes('task.title must not contain ", `, $, \\ or a newline'), JSON.stringify(title));
  }
  assert.equal(fs.existsSync(path.join(run, 'pending', 'work')), false);
  assert.equal(claim([run, '--add', 'work'], input(1, { title: 'Fix parse (old notes)' })).status, 0);
});

function planIn(t) {
  const file = path.join(tmpDir(t, 'orch-claim-plan'), 'plan.md');
  fs.writeFileSync(file, '# Plan\n\n## Global Constraints\n\n- one\n\n## Review Focus\n\n1. f\n\n## Dependencies\n\n- d\n\n---\n\n### Task 3: Three\n\nbody three\n');
  return file;
}
const pendingFiles = (run, kind) => (fs.existsSync(path.join(run, 'pending', kind)) ? fs.readdirSync(path.join(run, 'pending', kind)) : []);
const addedLines = (run) => (fs.existsSync(path.join(run, 'events.jsonl')) ? fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"added"')) : []);

test("--add work with reads sections stores the task's plan sections", (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'work'], input(3, { reads: 'sections', plan: planIn(t) }));
  assert.equal(r.status, 0, r.stderr);
  const stored = JSON.parse(fs.readFileSync(path.join(run, 'pending', 'work', r.stdout.trim()), 'utf8'));
  assert.match(stored.planExcerpt, /### Task 3: Three/);
  assert.match(stored.planExcerpt, /## Global Constraints/);
  const out = claim([run, 'work']).stdout;
  assert.ok(out.indexOf('Your sections of the plan follow.') > out.indexOf('Done when:'));
  assert.match(out, /### Task 3: Three/);
});

test('--add refuses reads sections when the plan has no section for the task', (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'work'], input(4, { reads: 'sections', plan: planIn(t) }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: /);
  assert.doesNotMatch(r.stderr, /has no a /);
  assert.match(r.stderr, /has no "### Task 4:" section/);
  assert.deepEqual(pendingFiles(run, 'work'), []);
  assert.deepEqual(addedLines(run), []);
});

test('--add refuses reads sections when the plan file is missing', (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'work'], input(3, { reads: 'sections', plan: '/nonexistent/plan.md' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: /);
  assert.deepEqual(pendingFiles(run, 'work'), []);
});

test('--add refuses an unknown reads value and reads on a review task', (t) => {
  const run = runIn(t);
  assert.equal(claim([run, '--add', 'work'], input(3, { reads: 'half' })).status, 1);
  const impl = { implementer: { agentId: 'a1', transcript: '/t/a.jsonl' } };
  assert.equal(claim([run, '--add', 'review'], input(3, { reads: 'sections', ...impl })).status, 1);
});

test('--add review drops a copied planExcerpt', (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'review'], input(3, { planExcerpt: '### Task 3: Three', implementer: { agentId: 'a1', transcript: '/t/a.jsonl' } }));
  assert.equal(r.status, 0, r.stderr);
  const stored = JSON.parse(fs.readFileSync(path.join(run, 'pending', 'review', r.stdout.trim()), 'utf8'));
  assert.equal('planExcerpt' in stored, false);
  assert.doesNotMatch(claim([run, 'review']).stdout, /Your sections of the plan/);
});

test('--add refuses reads sections for task 0 when the plan has no shared sections, and names them', (t) => {
  const run = runIn(t);
  const plan = path.join(tmpDir(t, 'orch-claim-plan'), 'plan.md');
  fs.writeFileSync(plan, '# Plan\n\n### Task 1: One\n\nbody\n');
  const r = claim([run, '--add', 'work'], input(0, { reads: 'sections', plan }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: /);
  assert.doesNotMatch(r.stderr, /has no a /);
  assert.match(r.stderr, /has no Global Constraints and Review Focus sections: run this plan with plan reads whole/);
  assert.doesNotMatch(r.stderr, /### Task 0/);
  assert.deepEqual(pendingFiles(run, 'work'), []);
});

const GC = '## Global Constraints\n\n- one\n\n';
const RF = '## Review Focus\n\n1. f\n\n';
function planText(t, text) {
  const file = path.join(tmpDir(t, 'orch-claim-plan'), 'plan.md');
  fs.writeFileSync(file, text);
  return file;
}

test('--add refuses reads sections when the plan lacks a required shared section, and names it', (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}### Task 1: One\n\nbody\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: /);
  assert.match(r.stderr, /Review Focus/);
  assert.match(r.stderr, /plan reads whole/);
  assert.deepEqual(pendingFiles(run, 'work'), []);
  assert.deepEqual(addedLines(run), []);
});

test('--add accepts a plan without Dependencies', (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}${RF}### Task 1: One\n\nbody\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan }));
  assert.equal(r.status, 0, r.stderr);
});

test('--add refuses a miscased shared heading and names it', (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}${RF}## dependencies\n\n- d\n\n### Task 1: One\n\nbody\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rename it to ## Dependencies/);
});

test('--add names two miscased shared headings with "and" and the plural', (t) => {
  const run = runIn(t);
  const plan = planText(t, '# Plan\n\n## Global constraints\n\n- one\n\n## Review focus\n\n1. f\n\n### Task 1: One\n\nbody\n');
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /spells the Global Constraints and Review Focus headings differently: rename them to ## Global Constraints and ## Review Focus\n/);
});

test('--add refuses an excerpt over 25,000 bytes', (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}${RF}### Task 1: One\n\n${'x'.repeat(26000)}\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: Task 1: the claim with its plan sections is \d+ bytes, over 25,000: /);
  assert.match(r.stderr, /plan reads whole/);
  assert.deepEqual(pendingFiles(run, 'work'), []);
  assert.deepEqual(addedLines(run), []);
});

test('--add refuses notes that are not a string', (t) => {
  const run = runIn(t);
  for (const over of [{ notes: 42 }, { notes: ['a'], reads: 'sections', plan: planText(t, `# Plan\n\n${GC}${RF}### Task 1: One\n\nbody\n`) }]) {
    const r = claim([run, '--add', 'work'], input(1, over));
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'orch-claim: task.notes must be a string\n');
  }
  assert.deepEqual(pendingFiles(run, 'work'), []);
});

test('--add counts the notes toward the limit', (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}${RF}### Task 1: One\n\n${'x'.repeat(20000)}\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan, notes: 'n'.repeat(6000) }));
  assert.equal(r.status, 1);
});

// The claim --add would print for task 1 of the plan at <file>, as the claim queue prints it.
function claimBytes(file, text) {
  const t1 = { ...task(1), reads: 'sections', plan: file, planExcerpt: planSections(text, 1) };
  return Buffer.byteLength(formatClaim('0001-t1-a1.json', t1));
}

test('--add accepts a claim of exactly 25,000 bytes and refuses one byte more', (t) => {
  const run = runIn(t);
  const head = `# Plan\n\n${GC}${RF}### Task 1: One\n\n`;
  const file = planText(t, `${head}x\n`);
  const pad = 25000 - claimBytes(file, `${head}x\n`) + 1;
  fs.writeFileSync(file, `${head}${'x'.repeat(pad)}\n`);
  assert.equal(claimBytes(file, fs.readFileSync(file, 'utf8')), 25000);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan: file }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Buffer.byteLength(claim([run, 'work']).stdout.replace(/\n$/, '')), 25000);
  fs.writeFileSync(file, `${head}${'x'.repeat(pad + 1)}\n`);
  const over = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan: file }));
  assert.equal(over.status, 1);
  assert.equal(over.stderr, 'orch-claim: Task 1: the claim with its plan sections is 25001 bytes, over 25,000: run this plan with plan reads whole\n');
});

test("--add counts the claim's other lines toward the limit", (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}${RF}### Task 1: One\n\nbody\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan, doneWhen: 'd'.repeat(25000) }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-claim: Task 1: the claim with its plan sections is \d+ bytes, over 25,000/);
  assert.deepEqual(pendingFiles(run, 'work'), []);
});

test('--add review with reads says to leave out the copied reads field', (t) => {
  const run = runIn(t);
  const r = claim([run, '--add', 'review'], input(3, { reads: 'sections', implementer: { agentId: 'a1', transcript: '/t/a.jsonl' } }));
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('leave out the reads field copied from the claimed work file'));
});

const TWO = `# Plan\n\n${GC}${RF}### Task 1: One\n\nshort\n\n### Task 2: Two\n\nshort\n`;
const TWO_BIG = `# Plan\n\n${GC}${RF}### Task 1: One\n\nshort\n\n### Task 2: Two\n\n${'x'.repeat(26000)}\n`;

test("--check-plan prints each task's excerpt length and exits 0", (t) => {
  const r = claim(['--check-plan', planText(t, TWO)]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  lines.forEach((l, i) => assert.match(l, new RegExp(`^Task ${i}: \\d+ bytes$`)));
});

test('--check-plan names each failing task and exits 1', (t) => {
  const r = claim(['--check-plan', planText(t, TWO_BIG)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^Task 0: /m);
  assert.match(r.stdout, /^Task 1: /m);
  assert.doesNotMatch(r.stdout, /^Task 2: /m);
  assert.equal(r.stderr.trim().split('\n').filter((l) => l.startsWith('orch-claim: Task 2: ')).length, 1);
  assert.match(r.stderr, /^orch-claim: Task 2: plan sections are \d+ bytes, over 25,000: run this plan with plan reads whole$/m);
  assert.doesNotMatch(r.stderr, /Task 2's/);
});

test('--check-plan reports a missing shared section once and still checks lengths', (t) => {
  const r = claim(['--check-plan', planText(t, `# Plan\n\n${GC}### Task 1: One\n\nshort\n\n### Task 2: Two\n\n${'x'.repeat(26000)}\n`)]);
  assert.equal(r.status, 1);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines.filter((l) => l.includes('Review Focus')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('orch-claim: Task 2: ')).length, 1);
  assert.match(r.stdout, /^Task 1: /m);
});

test('--check-plan with a run folder, a missing plan or no tasks exits 1', (t) => {
  const plan = planText(t, TWO);
  const a = claim(['--check-plan', plan, runIn(t)]);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /usage: /);
  const b = claim(['--check-plan', '/nonexistent/plan.md']);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /^orch-claim: /);
  const c = claim(['--check-plan', planText(t, `# Plan\n\n${GC}${RF}`)]);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /### Task/);
});

test('--check-plan lists ## sections no excerpt carries on stdout and still exits 0', (t) => {
  const text = `# Plan\n\n## Before you start\n\nrules\n\n${GC}${RF}### Task 1: One\n\nshort\n\n## Appendix: scripts\n\ncode\n`;
  const r = claim(['--check-plan', planText(t, text)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^Task 0: /);
  assert.match(lines[1], /^Task 1: /);
  assert.deepEqual(lines.slice(2), ['Not in any excerpt: ## Before you start', 'Not in any excerpt: ## Appendix: scripts']);
});

test('--check-plan refuses a plan with its own Task 0 and lists Task 0 once', (t) => {
  const r = claim(['--check-plan', planText(t, `# Plan\n\n${GC}${RF}### Task 0: Branch\n\nmake it\n\n### Task 1: One\n\nshort\n`)]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "orch-claim: Task 0 is reserved for stub and fix tasks: renumber the plan's Task 0\n");
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('Task 0: ')).length, 1);
});

test('--check-plan refuses a task number used twice, once per number', (t) => {
  const r = claim(['--check-plan', planText(t, `# Plan\n\n${GC}${RF}### Task 3: A\n\na\n\n### Task 3: B\n\nb\n\n### Task 3: C\n\nc\n`)]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'orch-claim: Task 3 appears more than once\n');
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('Task 3: ')).length, 1);
});

test('--add refuses a shared heading with a suffix and names it', (t) => {
  const run = runIn(t);
  const plan = planText(t, `# Plan\n\n${GC}${RF}## Dependencies:\n\n- d\n\n### Task 1: One\n\nbody\n`);
  const r = claim([run, '--add', 'work'], input(1, { reads: 'sections', plan }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rename it to ## Dependencies\n/);
});
