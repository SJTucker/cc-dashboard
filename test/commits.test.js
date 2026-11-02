'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const helpers = require('./helpers');
const { isCommitCommand, commitDir, resolveCommits, resetCommitState } = require('../lib/commits');

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
  const rows = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: one"' }).rows;
  const top = fs.realpathSync(dir);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].added, 3);
  assert.strictEqual(rows[0].removed, 1);
  assert.deepStrictEqual([...rows[0].files].sort(), ['a.txt', 'b.txt']);
  assert.strictEqual(rows[0].parent, first);
  assert.strictEqual(rows[0].amend, false);
});

test('resolveCommits ignores commits outside the window', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-out');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'old', 900);
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit -m old' }).rows, []);
});

test('resolveCommits skips merge commits', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-merge');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'side'], 1000);
  const side = commitFiles(dir, { 's.txt': 'x\n' }, 'side', 1000);
  git(dir, ['checkout', '-q', 'main'], 1000);
  const main = commitFiles(dir, { 'm.txt': 'x\n' }, 'main', 1000);
  git(dir, ['merge', '--no-ff', '-q', '-m', 'merge', 'side'], 1000);
  const rows = resolveCommits({ dir, ...WINDOW, command: 'git commit -F msg.txt' }).rows;
  assert.deepStrictEqual(rows.map((r) => r.sha).sort(), [side, main].sort());
});

test('resolveCommits prefers commits whose subject is in the command', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-subject');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'feat: one', 1000);
  const two = commitFiles(dir, { 'b.txt': 'x\n' }, 'feat: two', 1001);
  const hit = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: two"' }).rows;
  assert.deepStrictEqual(hit.map((r) => r.sha), [two]);
  const miss = resolveCommits({ dir, ...WINDOW, command: 'git commit -F msg.txt' }).rows;
  assert.strictEqual(miss.length, 2);
});

test('resolveCommits counts binary and lockfiles as zero', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-lock');
  fs.writeFileSync(path.join(dir, 'p.png'), Buffer.from([0, 1, 2, 0, 255, 0]));
  commitFiles(dir, { 'package-lock.json': lines(500), 'a.js': lines(2) }, 'deps', 1000);
  const [row] = resolveCommits({ dir, ...WINDOW, command: 'git commit -m deps' }).rows;
  assert.strictEqual(row.added, 2);
  assert.strictEqual(row.removed, 0);
  assert.deepStrictEqual(row.files.map((f) => path.basename(f)).sort(), ['a.js', 'p.png', 'package-lock.json']);
});

test('resolveCommits returns [] for a missing dir, cached and not transient', () => {
  assert.deepStrictEqual(resolveCommits({ dir: '/nonexistent/x', ...WINDOW, command: 'git commit -m x' }), { rows: [], transient: false });
});

test('resolveCommits falls back to findRepo for a deleted worktree', { skip: !hasGit }, (t) => {
  const base = helpers.tmpDir(t, 'commits-wt');
  const app = path.join(base, 'app');
  fs.mkdirSync(app);
  git(app, ['init', '-q', '-b', 'main'], 1);
  const sha = commitFiles(app, { 'a.txt': 'x\n' }, 'feat', 1000);
  const { rows } = resolveCommits({ dir: path.join(base, 'app.feature'), ...WINDOW, command: 'git commit -m feat' });
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

test('resolveCommits does not cache a transient failure and flags it', () => {
  let calls = 0;
  const run = () => {
    calls++;
    throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
  };
  const opts = { dir: os.tmpdir(), t0: 6_000_000, t1: 6_000_100, command: 'git commit -m x', run };
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: true });
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: true });
  assert.strictEqual(calls, 2);
});

test('resolveCommits caches a folder that is not a git repository', () => {
  let calls = 0;
  const run = () => {
    calls++;
    throw Object.assign(new Error('fatal'), { status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' });
  };
  const opts = { dir: os.tmpdir(), t0: 7_000_000, t1: 7_000_100, command: 'git commit -m x', run };
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: false });
  resolveCommits(opts);
  assert.strictEqual(calls, 1);
});

test('resolveCommits drops a rewritten copy made inside the window', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-rebase');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'side'], 100);
  commitFiles(dir, { 's.txt': lines(4) }, 'old work', 500);
  git(dir, ['checkout', '-q', 'main'], 600);
  const mine = commitFiles(dir, { 'm.txt': 'x\n' }, 'y', 1000);
  // Rebasing side onto main at 1000 s keeps the author time (500) and moves the committer time.
  git(dir, ['rebase', '-q', 'main', 'side'], 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m y && git rebase main side' });
  assert.deepStrictEqual(rows.map((r) => r.sha), [mine]);
});

test('resolveCommits keeps the old author time for an amend', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-amend');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'work', 500);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\ny\n');
  git(dir, ['add', '-A'], 1000);
  const env = { ...process.env, GIT_COMMITTER_DATE: '@1000 +0000' };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--amend', '--no-edit'], { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit --amend --no-edit' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].amend, true);
  assert.strictEqual(rows[0].authorTime, 500);
  assert.strictEqual(rows[0].toplevel, fs.realpathSync(dir));
});

test('resolveCommits reads --amend only from words outside quotes', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-amend-text');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'docs: explain --amend', 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "docs: explain --amend"' });
  assert.strictEqual(rows[0].amend, false);
  const heredoc = resolveCommits({ dir, ...WINDOW, command: "git commit -m \"$(cat <<'EOF'\ndocs: explain --amend\nEOF\n)\"" });
  assert.strictEqual(heredoc.rows[0].amend, false);
});

test('resolveCommits lists a non-ASCII file name unquoted', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-utf8');
  commitFiles(dir, { 'caf\u00e9.txt': 'x\n' }, 'utf8', 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m utf8' });
  assert.deepStrictEqual(rows[0].files, ['caf\u00e9.txt']);
});

const failing = (shape) => () => { throw Object.assign(new Error('git failed'), shape); };
const failShapes = {
  ENOENT: { code: 'ENOENT', errno: -2, syscall: 'spawnSync git' },
  stub: { status: 1, stderr: 'xcode-select: note: No developer tools were found, requesting install.\nxcrun: error: invalid active developer path' },
};

for (const [name, shape] of Object.entries(failShapes)) {
  test(`resolveCommits stops spawning git after the ${name} failure`, (t) => {
    t.after(resetCommitState);
    resetCommitState();
    let calls = 0;
    const run = (...a) => { calls++; return failing(shape)(...a); };
    const first = resolveCommits({ dir: os.tmpdir(), t0: 8_000_000, t1: 8_000_100, command: 'git commit -m x', run });
    assert.deepStrictEqual(first, { rows: [], transient: false });
    assert.strictEqual(calls, 1);
    const other = resolveCommits({ dir: os.tmpdir(), t0: 8_100_000, t1: 8_100_100, command: 'git commit -m y', run });
    assert.deepStrictEqual(other, { rows: [], transient: false });
    assert.strictEqual(calls, 1);
  });
}

test('resolveCommits caches a dubious-ownership failure without flagging it', (t) => {
  t.after(resetCommitState);
  resetCommitState();
  let calls = 0;
  const run = (...a) => { calls++; return failing({ status: 128, stderr: "fatal: detected dubious ownership in repository at '/r'" })(...a); };
  const opts = { dir: os.tmpdir(), t0: 8_200_000, t1: 8_200_100, command: 'git commit -m x', run };
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: false });
  resolveCommits(opts);
  assert.strictEqual(calls, 1);
});

test('resolveCommits flags a signal kill as transient and does not cache it', (t) => {
  t.after(resetCommitState);
  resetCommitState();
  let calls = 0;
  const run = (...a) => { calls++; return failing({ signal: 'SIGKILL', status: null })(...a); };
  const opts = { dir: os.tmpdir(), t0: 8_300_000, t1: 8_300_100, command: 'git commit -m x', run };
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: true });
  resolveCommits(opts);
  assert.strictEqual(calls, 2);
});

test('resolveCommits runs rev-parse once per directory', (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const seen = [];
  const run = (args) => { seen.push(args[0] === 'rev-parse' ? 'rev-parse' : 'log'); return args[0] === 'rev-parse' ? '/nonexistent-top\n' : ''; };
  const dir = os.tmpdir();
  resolveCommits({ dir, t0: 9_000_000, t1: 9_000_100, command: 'git commit -m x', run });
  resolveCommits({ dir, t0: 9_500_000, t1: 9_500_100, command: 'git commit -m x', run });
  assert.strictEqual(seen.filter((a) => a === 'rev-parse').length, 1);
  assert.ok(seen.filter((a) => a === 'log').length >= 2);
});

test('resolveCommits reads HEAD first, so a sibling worktree commit is not returned', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-sibling');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  const other = helpers.tmpDir(t, 'commits-sibling-wt') + '/wt';
  git(dir, ['worktree', 'add', '-q', '-b', 'other', other], 100);
  const mine = commitFiles(dir, { 'a.txt': lines(2) }, 'in a', 1000);
  commitFiles(other, { 'b.txt': lines(5) }, 'in b', 1001);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit --amend --no-edit' });
  assert.deepStrictEqual(rows.map((r) => r.sha), [mine]);
  assert.strictEqual(rows[0].amend, true);
  assert.strictEqual(rows[0].named, undefined);
});
