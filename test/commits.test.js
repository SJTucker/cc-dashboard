'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const helpers = require('./helpers');
const { isCommitCommand, commitDir, resolveCommits } = require('../lib/commits');

const hasGit = spawnSync('git', ['--version']).status === 0;

test('isCommitCommand recognises git commit calls', () => {
  for (const c of ['git commit -m x', 'cd /a && git add -A && git commit -m "x"', 'git -C /a commit -m x', 'rtk git commit -m x']) {
    assert.strictEqual(isCommitCommand(c), true, c);
  }
  for (const c of ['git commit-tree abc', 'git log --grep commit', 'echo "git commit"', 'git rebase --continue']) {
    assert.strictEqual(isCommitCommand(c), false, c);
  }
});

test('commitDir finds the directory a commit runs in', () => {
  assert.strictEqual(commitDir('cd /a/b && git commit -m x', '/c'), '/a/b');
  assert.strictEqual(commitDir('git -C /a commit -m x', '/c'), '/a');
  assert.strictEqual(commitDir('cd sub && git commit', '/c'), '/c/sub');
  assert.strictEqual(commitDir('cd ~/r && git commit', null), path.join(os.homedir(), 'r'));
  assert.strictEqual(commitDir('cd "/a b" && git commit', null), '/a b');
  assert.strictEqual(commitDir('git commit -m x', '/c'), '/c');
  assert.strictEqual(commitDir('git commit -m x', null), null);
  assert.strictEqual(commitDir('cd /a && cd /b && git commit -m x', '/c'), '/b');
});

function git(dir, args, secs) {
  const env = { ...process.env, GIT_AUTHOR_DATE: `@${secs} +0000`, GIT_COMMITTER_DATE: `@${secs} +0000` };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function initRepo(t, name) {
  const dir = helpers.tmpDir(t, name);
  git(dir, ['init', '-q', '-b', 'main'], 1);
  return dir;
}

function commitFiles(dir, files, msg, secs) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git(dir, ['add', '-A'], secs);
  git(dir, ['commit', '-q', '-m', msg], secs);
  return git(dir, ['rev-parse', 'HEAD'], secs);
}

const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}\n`).join('');
const WINDOW = { t0: 999_500, t1: 1_000_400 };

test('resolveCommits finds the commit in the window', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits');
  const first = commitFiles(dir, { 'b.txt': 'x\ny\n' }, 'init', 500);
  commitFiles(dir, { 'a.txt': lines(3), 'b.txt': 'x\n' }, 'feat: one', 1000);
  const rows = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: one"' });
  const top = fs.realpathSync(dir);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].added, 3);
  assert.strictEqual(rows[0].removed, 1);
  assert.deepStrictEqual([...rows[0].files].sort(), [path.join(top, 'a.txt'), path.join(top, 'b.txt')]);
  assert.strictEqual(rows[0].parent, first);
  assert.strictEqual(rows[0].amend, false);
});

test('resolveCommits ignores commits outside the window', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-out');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'old', 900);
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit -m old' }), []);
});

test('resolveCommits skips merge commits', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-merge');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'side'], 1000);
  const side = commitFiles(dir, { 's.txt': 'x\n' }, 'side', 1000);
  git(dir, ['checkout', '-q', 'main'], 1000);
  const main = commitFiles(dir, { 'm.txt': 'x\n' }, 'main', 1000);
  git(dir, ['merge', '--no-ff', '-q', '-m', 'merge', 'side'], 1000);
  const rows = resolveCommits({ dir, ...WINDOW, command: 'git commit -F msg.txt' });
  assert.deepStrictEqual(rows.map((r) => r.sha).sort(), [side, main].sort());
});

test('resolveCommits prefers commits whose subject is in the command', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-subject');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'feat: one', 1000);
  const two = commitFiles(dir, { 'b.txt': 'x\n' }, 'feat: two', 1001);
  const hit = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: two"' });
  assert.deepStrictEqual(hit.map((r) => r.sha), [two]);
  const miss = resolveCommits({ dir, ...WINDOW, command: 'git commit -F msg.txt' });
  assert.strictEqual(miss.length, 2);
});

test('resolveCommits counts binary and lockfiles as zero', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-lock');
  fs.writeFileSync(path.join(dir, 'p.png'), Buffer.from([0, 1, 2, 0, 255, 0]));
  commitFiles(dir, { 'package-lock.json': lines(500), 'a.js': lines(2) }, 'deps', 1000);
  const [row] = resolveCommits({ dir, ...WINDOW, command: 'git commit -m deps' });
  assert.strictEqual(row.added, 2);
  assert.strictEqual(row.removed, 0);
  assert.deepStrictEqual(row.files.map((f) => path.basename(f)).sort(), ['a.js', 'p.png', 'package-lock.json']);
});

test('resolveCommits returns [] for a missing dir', () => {
  assert.deepStrictEqual(resolveCommits({ dir: '/nonexistent/x', ...WINDOW, command: 'git commit -m x' }), []);
});

test('resolveCommits falls back to findRepo for a deleted worktree', { skip: !hasGit }, (t) => {
  const base = helpers.tmpDir(t, 'commits-wt');
  const app = path.join(base, 'app');
  fs.mkdirSync(app);
  git(app, ['init', '-q', '-b', 'main'], 1);
  const sha = commitFiles(app, { 'a.txt': 'x\n' }, 'feat', 1000);
  const rows = resolveCommits({ dir: path.join(base, 'app.feature'), ...WINDOW, command: 'git commit -m feat' });
  assert.deepStrictEqual(rows.map((r) => r.sha), [sha]);
});

test('resolveCommits caches by dir and window', () => {
  let calls = 0;
  const run = (args) => {
    calls++;
    return args[0] === 'rev-parse' ? '/nonexistent-top\n' : '';
  };
  const dir = os.tmpdir();
  const opts = { dir, t0: 5_000_000, t1: 5_000_100, command: 'git commit -m x', run };
  resolveCommits(opts);
  const first = calls;
  assert.ok(first > 0);
  resolveCommits(opts);
  assert.strictEqual(calls, first);
});
