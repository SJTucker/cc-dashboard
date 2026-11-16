'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, git, gitRepo } = require('./helpers');
const { parseGitLog, lateCommits } = require('../lib/orchestrations/misses');

const MISSES = path.join(__dirname, '..', 'bin', 'orch-misses');

const at = (s) => new Date(`2026-11-14T10:00:${String(s).padStart(2, '0')}Z`).toISOString();
const ev = (s, fields) => ({ t: at(s), ...fields });
const commit = (s, sha, files, subject = 'fix') => ({ sha, t: Date.parse(at(s)), subject, files });

test('parseGitLog reads sha, time, subject and files', () => {
  const text = ['aaa111\t1700000000\tfix: a thing', '', 'lib/a.js', 'lib/b.js', '', 'bbb222\t1700000100\tdocs: more\twith a tab', '', 'README.md', ''].join('\n');
  assert.deepStrictEqual(parseGitLog(text), [
    { sha: 'aaa111', t: 1700000000000, subject: 'fix: a thing', files: ['lib/a.js', 'lib/b.js'] },
    { sha: 'bbb222', t: 1700000100000, subject: 'docs: more\twith a tab', files: ['README.md'] },
  ]);
});

test('lateCommits reports a commit after review-pass that touches the task\'s file', () => {
  const events = [ev(1, { kind: 'claimed', task: 1 }), ev(5, { kind: 'review-pass', task: 1 }), ev(6, { kind: 'merged', task: 1 })];
  const out = lateCommits({ events, tasks: { 1: ['lib/a.js'] }, commits: [commit(10, 'c1', ['lib/a.js', 'lib/z.js'], 'fix a')] });
  assert.deepStrictEqual(out, [{ task: 1, sha: 'c1', subject: 'fix a', files: ['lib/a.js'] }]);
});

test('a commit before review-pass is not reported', () => {
  const events = [ev(5, { kind: 'review-pass', task: 1 }), ev(6, { kind: 'merged', task: 1 })];
  assert.deepStrictEqual(lateCommits({ events, tasks: { 1: ['lib/a.js'] }, commits: [commit(3, 'c1', ['lib/a.js'])] }), []);
});

test('a fix after review-pass but before merged is not reported', () => {
  const events = [ev(5, { kind: 'review-pass', task: 1 }), ev(8, { kind: 'merged', task: 1 })];
  assert.deepStrictEqual(lateCommits({ events, tasks: { 1: ['lib/a.js'] }, commits: [commit(6, 'c1', ['lib/a.js'])] }), []);
});

test('a commit inside another task\'s claimed-to-merged window on a shared file is not reported', () => {
  const events = [
    ev(1, { kind: 'review-pass', task: 1 }),
    ev(2, { kind: 'merged', task: 1 }),
    ev(10, { kind: 'claimed', file: '0003-t2-a1.json' }),
    ev(20, { kind: 'merged', task: 2 }),
  ];
  const tasks = { 1: ['lib/a.js'], 2: ['lib/a.js', 'lib/b.js'] };
  assert.deepStrictEqual(lateCommits({ events, tasks, commits: [commit(15, 'c1', ['lib/a.js'])] }), []);
  // The same time on a file task 2 does not list is still reported.
  const out = lateCommits({ events, tasks: { 1: ['lib/a.js', 'lib/q.js'], 2: ['lib/b.js'] }, commits: [commit(15, 'c2', ['lib/q.js'])] });
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, 'c2');
});

test('a commit inside another task\'s window is not reported when only a file outside the shared ones is task M\'s', () => {
  const events = [
    ev(1, { kind: 'review-pass', task: 1 }),
    ev(2, { kind: 'merged', task: 1 }),
    ev(3, { kind: 'review-pass', task: 2 }),
    ev(4, { kind: 'merged', task: 2 }),
    ev(10, { kind: 'claimed', file: '0005-t4-a1.json' }),
    ev(20, { kind: 'merged', task: 4 }),
  ];
  const tasks = { 1: ['lib/events.js'], 2: ['lib/report.js'], 4: ['bin/misses'] };
  const out = lateCommits({ events, tasks, commits: [commit(15, 'c1', ['bin/misses', 'lib/events.js', 'lib/report.js'])] });
  assert.deepStrictEqual(out, []);
});

test('task 0 is never reported', () => {
  const events = [ev(1, { kind: 'review-pass', task: 0 }), ev(2, { kind: 'merged', task: 0 })];
  assert.deepStrictEqual(lateCommits({ events, tasks: { 0: ['lib/a.js'] }, commits: [commit(10, 'c1', ['lib/a.js'])] }), []);
});

test('task 0 never opens a window, even with claimed and merged events', () => {
  const events = [
    ev(1, { kind: 'review-pass', task: 1 }),
    ev(2, { kind: 'merged', task: 1 }),
    ev(10, { kind: 'claimed', file: '0003-t0-a1.json' }),
    ev(20, { kind: 'merged', task: 0 }),
  ];
  const out = lateCommits({ events, tasks: { 0: ['lib/a.js'], 1: ['lib/a.js'] }, commits: [commit(15, 'c1', ['lib/a.js'])] });
  assert.deepStrictEqual(out.map((o) => o.task), [1]);
});

test('a task with no merged event has no window, so a late fix on its file is still reported for another task', () => {
  const events = [
    ev(1, { kind: 'review-pass', task: 1 }),
    ev(2, { kind: 'merged', task: 1 }),
    ev(5, { kind: 'claimed', file: '0003-t0-a1.json' }),
    ev(6, { kind: 'claimed', file: '0004-t3-a1.json' }),
    ev(7, { kind: 'review-pass', task: 3 }),
  ];
  const tasks = { 0: ['lib/a.js'], 1: ['lib/a.js'], 3: ['lib/a.js'] };
  const out = lateCommits({ events, tasks, commits: [commit(10, 'c1', ['lib/a.js'])] });
  assert.deepStrictEqual(out.map((o) => o.task).sort(), [1, 3]);
});

test('final-review fixes list only kind work Task 0 files claimed after the final-review event', (t) => {
  const { run, image, repo } = fixture(t);
  writeClaimed(run, '0001-t1-a1.json', { task: 1, kind: 'work', files: ['lib/a.js'], claimedAt: at(1) });
  writeClaimed(run, '0002-t0-a1.json', { task: 0, kind: 'work', title: 'early stub', notes: 'stub notes', files: ['lib/a.js'], claimedAt: at(2) });
  writeClaimed(run, '0003-t0-a1.json', { task: 0, kind: 'work', title: 'fix findings', notes: 'N'.repeat(500), files: ['lib/a.js'], claimedAt: at(30) });
  writeClaimed(run, '0004-t0-a1.json', { task: 0, kind: 'review', title: 'review of fixes', notes: 'review notes', files: ['lib/a.js'], claimedAt: at(31) });
  writeEvents(run, [ev(1, { kind: 'added', task: 1 }), ev(20, { kind: 'final-review', agent: 'f1' })]);
  const r = spawnSync(process.execPath, [MISSES, image, '--branch', 'HEAD', '--base', 'HEAD'], { encoding: 'utf8', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Final-review fixes:\n.*fix findings/);
  assert.ok(r.stdout.includes('N'.repeat(400)));
  assert.ok(!r.stdout.includes('N'.repeat(401)));
  assert.ok(!r.stdout.includes('early stub'));
  assert.ok(!r.stdout.includes('review of fixes'));
});

function fixture(t) {
  const base = tmpDir(t, 'misses');
  const image = path.join(base, 'img.md');
  fs.writeFileSync(image, 'x');
  const run = path.join(base, 'img.run');
  fs.mkdirSync(path.join(run, 'claimed'), { recursive: true });
  return { base, image, run, repo: gitRepo(t) };
}

function writeClaimed(run, name, task) {
  fs.writeFileSync(path.join(run, 'claimed', name), JSON.stringify(task));
}

function writeEvents(run, list) {
  fs.writeFileSync(path.join(run, 'events.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('orch-misses lists a late fix commit and a final-review fix', (t) => {
  const { run, image, repo } = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(repo, 'lib/a.js'), 'a2');
  git(repo, 'commit', '-qam', 'fix: late change to a');
  fs.writeFileSync(path.join(repo, 'lib/other.js'), 'o');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'feat: unrelated');
  // Real commits are in 2026 or later; events sit in 2020.
  writeClaimed(run, '0001-t1-a1.json', { task: 1, kind: 'work', files: ['lib/a.js'], claimedAt: '2020-01-01T00:00:01.000Z' });
  writeClaimed(run, '0002-t0-a1.json', { task: 0, kind: 'work', title: 'fix the findings', notes: 'Finding one', files: ['lib/a.js'], claimedAt: '2020-01-01T00:00:30.000Z' });
  writeEvents(run, [
    { t: '2020-01-01T00:00:05.000Z', kind: 'review-pass', task: 1 },
    { t: '2020-01-01T00:00:06.000Z', kind: 'merged', task: 1 },
    { t: '2020-01-01T00:00:20.000Z', kind: 'final-review', agent: 'f1' },
  ]);
  const r = spawnSync(process.execPath, [MISSES, image, '--branch', 'HEAD', '--base', base], { encoding: 'utf8', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Candidates:\nTask 1 +[0-9a-f]{7} +fix: late change to a +lib\/a\.js\n/);
  assert.ok(!r.stdout.includes('unrelated'));
  assert.match(r.stdout, /Final-review fixes:\n.*fix the findings.*Finding one/);
});

test('orch-misses prints none under an empty heading', (t) => {
  const { run, image, repo } = fixture(t);
  writeEvents(run, [{ t: '2020-01-01T00:00:05.000Z', kind: 'review-pass', task: 1 }]);
  const r = spawnSync(process.execPath, [MISSES, image, '--branch', 'HEAD', '--base', 'HEAD'], { encoding: 'utf8', cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Candidates:\nnone\n\nFinal-review fixes:\nnone\n');
});
