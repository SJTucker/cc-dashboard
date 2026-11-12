'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const {
  addTask, claimNext, release, readClaimed, status, formatClaim, claimsInTranscript, validRunDir, runDirOf, TASK_FILE,
} = require('../lib/orchestrations/claims');

const impl = { agentId: 'a1', transcript: '/t/agent-a1.jsonl' };
function task(n) {
  return {
    kind: 'work', task: n, title: 'Parse the field', plan: '/p/plan.md', worktree: `/wt/t${n}`, branch: `b-t${n}`,
    files: ['lib/a.js', 'test/a.test.js'], doneWhen: 'node --test test/a.test.js passes', sections: ['Decisions'], attempt: 1,
  };
}
function runIn(t) {
  return path.join(tmpDir(t, 'claims'), 'img.run');
}

test('runDirOf and validRunDir', () => {
  assert.equal(runDirOf('/a/img.md'), '/a/img.run');
  assert.ok(validRunDir('/a/img.run'));
  for (const bad of ['a/img.run', '/a/img', '/a/../a/img.run', '/a//img.run', 5, null]) assert.equal(validRunDir(bad), false, String(bad));
  assert.ok(TASK_FILE.test('0001-t3-a1.json'));
});

test('addTask names files <seq>-t<N>-a<attempt>.json in order across both queues and claimed/', (t) => {
  const run = runIn(t);
  assert.equal(addTask(run, 'work', task(3)), '0001-t3-a1.json');
  assert.equal(addTask(run, 'review', { ...task(3), kind: 'review', implementer: impl }), '0002-t3-a1.json');
  assert.equal(addTask(run, 'work', { ...task(3), attempt: 2 }), '0003-t3-a2.json');
  claimNext(run, 'work');
  assert.equal(addTask(run, 'work', task(4)), '0004-t4-a1.json');
});

test('addTask leaves no dot file behind and claimers skip dot files', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(1));
  assert.deepEqual(fs.readdirSync(path.join(run, 'pending', 'work')), ['0001-t1-a1.json']);
  fs.writeFileSync(path.join(run, 'pending', 'work', '.x.tmp'), '{');
  claimNext(run, 'work');
  assert.equal(claimNext(run, 'work'), null);
});

test('claimNext takes the lowest file, moves it to claimed/ and stamps claimedAt', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(3));
  addTask(run, 'work', task(4));
  const now = new Date('2026-11-11T10:00:00Z');
  const r = claimNext(run, 'work', now);
  assert.equal(r.file, '0001-t3-a1.json');
  assert.equal(r.task.task, 3);
  assert.equal(fs.existsSync(path.join(run, 'pending', 'work', r.file)), false);
  assert.equal(readClaimed(run, r.file).claimedAt, now.toISOString());
  assert.deepEqual(fs.readdirSync(path.join(run, 'claimed')), [r.file]);
});

test('claimNext still returns its claim when another claimer removed the pending copy first', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(3));
  const r = claimNext(run, 'work', new Date(), { afterLink: (p) => fs.rmSync(p) });
  assert.equal(r.file, '0001-t3-a1.json');
  assert.ok(readClaimed(run, r.file).claimedAt);
});

test('claimNext returns null on an empty or missing queue', (t) => {
  const run = runIn(t);
  assert.equal(claimNext(run, 'work'), null);
  assert.equal(claimNext(run, 'review'), null);
});

test('claimNext keeps work and review queues apart', (t) => {
  const run = runIn(t);
  addTask(run, 'review', { ...task(3), kind: 'review', implementer: impl });
  assert.equal(claimNext(run, 'work'), null);
  assert.equal(claimNext(run, 'review').file, '0001-t3-a1.json');
});

test('a pending file whose name is already in claimed/ is removed and skipped', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(3));
  addTask(run, 'work', task(4));
  fs.mkdirSync(path.join(run, 'claimed'), { recursive: true });
  fs.copyFileSync(path.join(run, 'pending', 'work', '0001-t3-a1.json'), path.join(run, 'claimed', '0001-t3-a1.json'));
  assert.equal(claimNext(run, 'work').file, '0002-t4-a1.json');
  assert.equal(fs.existsSync(path.join(run, 'pending', 'work', '0001-t3-a1.json')), false);
});

test('release moves a claimed file back to its pending queue', (t) => {
  const run = runIn(t);
  addTask(run, 'review', { ...task(3), kind: 'review', implementer: impl });
  const { file } = claimNext(run, 'review');
  release(run, file);
  assert.equal(fs.existsSync(path.join(run, 'claimed', file)), false);
  const back = JSON.parse(fs.readFileSync(path.join(run, 'pending', 'review', file), 'utf8'));
  assert.equal(back.claimedAt, undefined);
  assert.equal(claimNext(run, 'review').file, file);
});

test('status lists pending files per queue and claimed files with no claimedAt', (t) => {
  const run = runIn(t);
  addTask(run, 'work', task(1));
  addTask(run, 'work', task(2));
  addTask(run, 'review', { ...task(1), kind: 'review', implementer: impl });
  claimNext(run, 'work');
  fs.writeFileSync(path.join(run, 'claimed', '0005-t2-a1.json'), JSON.stringify(task(2)));
  assert.deepEqual(status(run), { work: ['0002-t2-a1.json'], review: ['0003-t1-a1.json'], unstamped: ['0005-t2-a1.json'] });
});

test('readClaimed returns null for a bad name, a missing file, unparseable JSON or files that are not strings', (t) => {
  const run = runIn(t);
  fs.mkdirSync(path.join(run, 'claimed'), { recursive: true });
  fs.writeFileSync(path.join(run, 'x.json'), JSON.stringify(task(1)));
  assert.equal(readClaimed(run, '../x.json'), null);
  assert.equal(readClaimed(run, '0009-t1-a1.json'), null);
  fs.writeFileSync(path.join(run, 'claimed', '0001-t1-a1.json'), '{');
  assert.equal(readClaimed(run, '0001-t1-a1.json'), null);
  fs.writeFileSync(path.join(run, 'claimed', '0001-t1-a1.json'), JSON.stringify({ ...task(1), files: [1] }));
  assert.equal(readClaimed(run, '0001-t1-a1.json'), null);
  fs.writeFileSync(path.join(run, 'claimed', '0002-t1-a1.json'), JSON.stringify(task(1)));
  assert.equal(readClaimed(run, '0002-t1-a1.json').task, 1);
  assert.equal(readClaimed('rel.run', '0002-t1-a1.json'), null);
});

test('formatClaim gives the worktree, task, files, Done when and notes', () => {
  const out = formatClaim('0001-t3-a1.json', { ...task(3), notes: 'use the fix from review 1.' });
  const lines = out.split('\n');
  assert.equal(lines[0], 'CLAIMED 0001-t3-a1.json');
  assert.ok(out.includes('Your worktree is /wt/t3; run every command there and touch no other checkout.'));
  assert.ok(out.includes('Task 3 of /p/plan.md, "Parse the field".'));
  assert.ok(out.includes('Files this task touches: lib/a.js, test/a.test.js.'));
  assert.ok(out.includes('Done when: node --test test/a.test.js passes.'));
  assert.equal(lines[lines.length - 1], 'Notes: use the fix from review 1.');
  const rev = formatClaim('0002-t3-a1.json', { ...task(3), kind: 'review', implementer: impl });
  assert.ok(rev.includes('Review Task 3 of /p/plan.md, "Parse the field".'));
  assert.ok(rev.includes('Implementer transcript: /t/agent-a1.jsonl'));
});

test('claimsInTranscript finds each orch-claim Bash result that starts with CLAIMED', () => {
  const use = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const res = (id, content, extra = {}) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
  const lines = [
    use('u1', "/c/bin/orch-claim '/p/img.run' work"),
    res('u1', 'CLAIMED 0001-t3-a1.json\nYour worktree is /wt'),
    use('u2', "/c/bin/orch-claim '/p/img.run' work"),
    res('u2', 'NO TASK: the work queue is empty. Report that and stop.'),
    use('u3', 'echo CLAIMED 0009-t1-a1.json'),
    res('u3', 'CLAIMED 0009-t1-a1.json'),
    use('u4', '/c/bin/orch-claim /p/img.run review'),
    res('u4', 'CLAIMED 0002-t3-a1.json', { is_error: true }),
    use('u5', '/c/bin/orch-claim /p/img.run review'),
    res('u5', [{ type: 'text', text: 'CLAIMED 0003-t4-a1.json\nx' }]),
    'not json CLAIMED ',
  ];
  assert.deepEqual(claimsInTranscript(lines), [{ file: '0001-t3-a1.json', line: 2 }, { file: '0003-t4-a1.json', line: 10 }]);
});

test('claimsInTranscript finds CLAIMED at the start of any line and ignores non-task names', () => {
  const use = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const res = (id, content) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const lines = [
    use('u1', 'cd /wt && pwd && /c/bin/orch-claim /p/img.run work'),
    res('u1', '/wt\nCLAIMED 0004-t2-a1.json\nYour worktree is /wt'),
    use('u2', '/c/bin/orch-claim /p/img.run work'),
    res('u2', 'CLAIMED: none\nCLAIMED notes.txt'),
  ];
  assert.deepEqual(claimsInTranscript(lines), [{ file: '0004-t2-a1.json', line: 2 }]);
});
