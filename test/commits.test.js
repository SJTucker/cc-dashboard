'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const helpers = require('./helpers');
const { lineRows } = require('../lib/lines');
const { isCommitCommand, commitDirs, resolveCommits, resetCommitState, resetEvents } = require('../lib/commits');

const hasGit = spawnSync('git', ['--version']).status === 0;

test('isCommitCommand recognises git commit calls', () => {
  for (const c of ['git commit -m x', 'cd /a && git add -A && git commit -m "x"', 'git -C /a commit -m x', 'rtk git commit -m x']) {
    assert.strictEqual(isCommitCommand(c), true, c);
  }
  for (const c of ['git commit-tree abc', 'git log --grep commit', 'echo "git commit"', 'git rebase --continue']) {
    assert.strictEqual(isCommitCommand(c), false, c);
  }
});

test('commitDirs closes a subshell whose commit message holds a parenthesis', () => {
  assert.deepStrictEqual(commitDirs('(cd /a && git commit -m "fix(x)") && git commit -m y', '/c'), ['/a', '/c']);
});

test('commitDirs lists the directory of every git commit segment', () => {
  assert.deepStrictEqual(commitDirs('cd /a && git commit -m x; cd /b && git commit -m y', '/c'), ['/a', '/b']);
  assert.deepStrictEqual(commitDirs('(cd /a && git commit -m x)', '/c'), ['/a']);
  assert.deepStrictEqual(commitDirs('(cd /a) && git commit -m x', '/c'), ['/c']);
  assert.deepStrictEqual(commitDirs('git -C /r commit -C HEAD --amend', '/c'), ['/r']);
  assert.deepStrictEqual(commitDirs('git commit -C HEAD', '/c'), ['/c']);
  assert.deepStrictEqual(commitDirs('git commit -m x && git commit -m y', '/c'), ['/c']);
  assert.deepStrictEqual(commitDirs('git status', '/c'), []);
  assert.deepStrictEqual(commitDirs('(cd /a && git commit -m "x(y)"; cd b && git commit -m z)', '/c'), ['/a', '/a/b']);
  assert.deepStrictEqual(commitDirs('(cd /a && git commit -m fix(x); cd b && git commit -m z)', '/c'), ['/a', '/a/b']);
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

test('resolveCommits does not latch gitUnavailable for a deleted folder', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const gone = path.join(helpers.tmpDir(t, 'commits-gone'), 'deleted');
  const enoent = { code: 'ENOENT', syscall: 'spawnSync git', path: 'git' };
  let spawned = 0;
  const run = (...a) => { spawned++; return failing(enoent)(...a); };
  assert.deepStrictEqual(resolveCommits({ dir: gone, ...WINDOW, command: 'git commit -m x', run }), { rows: [], transient: false });
  assert.strictEqual(spawned, 0, 'a missing folder is not sent to git');
  // ENOENT for a folder that has vanished since the existence check is "gone", not "no git".
  const vanishing = helpers.tmpDir(t, 'commits-vanish');
  resolveCommits({ dir: vanishing, t0: 1, t1: 2, command: 'git commit -m x', run: (...a) => { fs.rmSync(vanishing, { recursive: true }); return failing(enoent)(...a); } });
  const dir = initRepo(t, 'commits-after-gone');
  const sha = commitFiles(dir, { 'a.txt': 'x\n' }, 'feat: live', 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: live"' });
  assert.deepStrictEqual(rows.map((r) => r.sha), [sha]);
});

test('resolveCommits still latches on ENOENT when the folder exists', (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const enoent = { code: 'ENOENT', syscall: 'spawnSync git', path: 'git' };
  let calls = 0;
  const run = (...a) => { calls++; return failing(enoent)(...a); };
  resolveCommits({ dir: os.tmpdir(), t0: 11_000_000, t1: 11_000_100, command: 'git commit -m x', run });
  resolveCommits({ dir: os.tmpdir(), t0: 12_000_000, t1: 12_000_100, command: 'git commit -m y', run });
  assert.strictEqual(calls, 1);
});

test('resolveCommits skips --all for a failed call', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-failed');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  const other = helpers.tmpDir(t, 'commits-failed-wt') + '/wt';
  git(dir, ['worktree', 'add', '-q', '-b', 'other', other], 100);
  commitFiles(other, { 'b.txt': lines(5) }, 'in b', 1001);
  const cmd = 'git commit --amend --no-edit';
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: cmd, failed: true }).rows, []);
  assert.strictEqual(resolveCommits({ dir, ...WINDOW, command: cmd }).rows.length, 1, 'a call that did not fail still falls back to --all');
});

test('a file named HEAD in the folder does not break the lookup', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-head-file');
  const sha = commitFiles(dir, { 'a.txt': 'x\n' }, 'feat: a', 1000);
  fs.writeFileSync(path.join(dir, 'HEAD'), 'untracked\n');
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: a"' }).rows.map((r) => r.sha), [sha]);
});

test('a stash is not taken for a commit', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-stash');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\ny\nz\n');
  git(dir, ['stash', '-q'], 1000);
  // HEAD has nothing in the window, so the --all query runs and must skip refs/stash.
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git stash' }).rows, []);
  const sha = commitFiles(dir, { 'b.txt': 'x\n' }, 'real', 1000);
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit -m real; git stash' }).rows.map((r) => r.sha), [sha]);
});

test('a rename counts the changed lines only', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-rename');
  commitFiles(dir, { 'a.js': 'one\ntwo\nthree\nfour\nfive\nsix\n' }, 'base', 100);
  git(dir, ['mv', 'a.js', 'b.js'], 1000);
  fs.writeFileSync(path.join(dir, 'b.js'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n');
  git(dir, ['add', '-A'], 1000);
  git(dir, ['commit', '-q', '-m', 'mv'], 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m mv' });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0].added, rows[0].removed, rows[0].files], [1, 1, ['b.js']]);
});

test('--date and -C commits keep their author time exemption', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-exempt');
  const old = commitFiles(dir, { 'a.txt': 'x\n' }, 'old', 100);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x\n');
  git(dir, ['add', '-A'], 1000);
  const env = { ...process.env, GIT_COMMITTER_DATE: '@1000 +0000' };
  const commit = (args) => {
    const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', ...args], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: '@100 +0000' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  commit(['--date=@100 +0000', '-m', 'dated']);
  const dated = git(dir, ['rev-parse', 'HEAD'], 1000);
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit --date=@100 -m dated' }).rows.map((r) => r.sha), [dated]);
  fs.writeFileSync(path.join(dir, 'c.txt'), 'x\n');
  git(dir, ['add', '-A'], 1000);
  commit(['-C', old]);
  const reused = git(dir, ['rev-parse', 'HEAD'], 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: `git commit -C ${old}` });
  assert.ok(rows.some((r) => r.sha === reused), 'the -C commit is returned');
});

test('an amend followed by a rebase exempts only the amended commit', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-amend-rebase');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'side'], 100);
  commitFiles(dir, { 's.txt': lines(4) }, 'old side', 500);
  git(dir, ['checkout', '-q', 'main'], 600);
  commitFiles(dir, { 'm.txt': 'x\n' }, 'work', 700);
  fs.writeFileSync(path.join(dir, 'm.txt'), 'x\ny\n');
  git(dir, ['add', '-A'], 999);
  const env = { ...process.env, GIT_COMMITTER_DATE: '@999 +0000' };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--amend', '--no-edit'], { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const amended = git(dir, ['rev-parse', 'HEAD'], 999);
  // The rebase rewrites `side` after the amend, so its copy has the later committer time.
  git(dir, ['rebase', '-q', 'main', 'side'], 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit --amend --no-edit && git rebase main side' });
  assert.deepStrictEqual(rows.filter((x) => !x.rewrite).map((x) => x.sha), [amended]);
  assert.ok(rows.filter((x) => x.rewrite).length > 0, 'the rebased copy of side is a rewrite row, not exempt');
});

test('ENOBUFS is permanent, cached and named in a warning', (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const warnings = [];
  t.mock.method(console, 'warn', (...a) => warnings.push(a.join(' ')));
  let calls = 0;
  const run = () => { calls++; throw { code: 'ENOBUFS', signal: 'SIGTERM' }; };
  const dir = os.tmpdir();
  const opts = { dir, t0: 13_000_000, t1: 13_000_100, command: 'git commit -m x', run };
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: false });
  const first = calls;
  assert.deepStrictEqual(resolveCommits(opts), { rows: [], transient: false });
  assert.strictEqual(calls, first);
  assert.ok(warnings.some((w) => w.includes(dir)));
});

test('a file name with a newline is counted and listed', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  resetCommitState();
  const dir = initRepo(t, 'commits-newline');
  const sha = commitFiles(dir, { 'n\nl.txt': 'x\n', 't\tab.txt': 'y\n' }, 'odd names', 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "odd names"' });
  assert.deepStrictEqual(rows.map((r) => r.sha), [sha]);
  assert.strictEqual(rows[0].added, 2);
  assert.deepStrictEqual([...rows[0].files].sort(), ['n\nl.txt', 't\tab.txt']);
});

// A run stub that forwards to git and throws for the calls `fail` matches.
function gitRun(fail) {
  const { execFileSync } = require('child_process');
  return (args, cwd, opts = {}) => {
    if (fail && fail(args)) throw Object.assign(new Error('git failed'), { status: 129, stderr: 'error: unknown option' });
    return execFileSync('git', args, { cwd, encoding: opts.encoding ?? 'utf8', input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] });
  };
}

test('rows carry a patchId that matches a cherry-picked copy', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-patchid');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'a'], 100);
  const x = commitFiles(dir, { 'x.txt': lines(3) }, 'feat: x', 1000);
  git(dir, ['checkout', '-q', 'main'], 1000);
  git(dir, ['cherry-pick', x], 1001);
  const a = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: x"', run: gitRun() });
  git(dir, ['checkout', '-q', 'a'], 1000);
  resetCommitState();
  const b = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: x"', run: gitRun() });
  // The HEAD reflog also lists the commit on branch `a`, so only the rows reachable from HEAD are compared.
  const reach = (r) => r.rows.filter((x) => !x.fromReflog);
  assert.strictEqual(reach(a).length, 1);
  assert.strictEqual(reach(b).length, 1);
  assert.notStrictEqual(reach(a)[0].sha, reach(b)[0].sha);
  assert.match(reach(a)[0].patchId, /^[0-9a-f]{40}/);
  assert.strictEqual(reach(a)[0].patchId, reach(b)[0].patchId);
});

for (const attr of ['linguist-generated', 'linguist-vendored']) {
  test(`generated files count 0 and the commit still gets a patchId (${attr})`, { skip: !hasGit }, (t) => {
    const dir = initRepo(t, `commits-gen-${attr}`);
    commitFiles(dir, { 'base.txt': 'x\n', '.gitattributes': `data/** ${attr}\n` }, 'base', 100);
    fs.mkdirSync(path.join(dir, 'data'));
    commitFiles(dir, { 'data/big.md': lines(500), 'a.js': lines(2) }, 'feat: data', 1000);
    const { rows, transient } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: data"' });
    assert.strictEqual(transient, false);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].added, 2);
    assert.strictEqual(rows[0].removed, 0);
    assert.deepStrictEqual(rows[0].generated, ['data/big.md']);
    assert.ok(rows[0].files.includes('data/big.md'));
    assert.ok(rows[0].patchId);
  });
}

test('attributes come from the commit\'s own tree', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-gen-tree');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  fs.mkdirSync(path.join(dir, 'data'));
  commitFiles(dir, { '.gitattributes': 'data/** linguist-generated\n', 'data/big.md': lines(500), 'a.js': lines(2) }, 'feat: both', 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: both"' });
  // a.js (2 lines) and the one-line .gitattributes count. data/big.md counts 0.
  assert.strictEqual(rows[0].added, 3);
  assert.deepStrictEqual(rows[0].generated, ['data/big.md']);
});

test('an old git without check-attr --source falls back to the working tree', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-gen-old');
  commitFiles(dir, { 'base.txt': 'x\n', '.gitattributes': 'data/** linguist-generated\n' }, 'base', 100);
  fs.mkdirSync(path.join(dir, 'data'));
  commitFiles(dir, { 'data/big.md': lines(50), 'a.js': lines(2) }, 'feat: data', 1000);
  const calls = [];
  const noSource = (args) => { calls.push(args); return args.includes('check-attr') && args.some((a) => a.startsWith('--source')); };
  const one = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: data"', run: gitRun(noSource) });
  assert.strictEqual(one.rows[0].added, 2);
  assert.deepStrictEqual(one.rows[0].generated, ['data/big.md']);
  assert.ok(calls.some((a) => a.includes('check-attr') && !a.some((x) => x.startsWith('--source'))));
  resetCommitState();
  const both = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "feat: data"', run: gitRun((args) => args.includes('check-attr')) });
  assert.strictEqual(both.transient, false);
  assert.strictEqual(both.rows.length, 1);
  assert.deepStrictEqual(both.rows[0].generated, []);
  assert.ok(both.rows[0].patchId);
});

function amendTwoStep(dir, secs) {
  fs.appendFileSync(path.join(dir, 'a.txt'), lines(3));
  git(dir, ['add', '-A'], secs);
  git(dir, ['commit', '-q', '--amend', '--no-edit'], secs);
}

test('an amend row carries amendOf from the reflog', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-amendof');
  const c1 = commitFiles(dir, { 'a.txt': lines(10) }, 'work', 500);
  amendTwoStep(dir, 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit --amend --no-edit', run: gitRun() });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].amend, true);
  assert.strictEqual(rows[0].added, 13);
  assert.deepStrictEqual(rows[0].amendOf, { sha: c1, added: 3, removed: 0 });
});

test('an amend in a folder without a reflog has amendOf null', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-noreflog');
  commitFiles(dir, { 'a.txt': lines(10) }, 'work', 500);
  amendTwoStep(dir, 1000);
  const { rows, transient } = resolveCommits({ dir, ...WINDOW, command: 'git commit --amend --no-edit', run: gitRun((args) => args.includes('-g')) });
  assert.strictEqual(transient, false);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].amendOf, null);
});

// A gitRun whose calls that mention `word` time out.
function slowOn(word) {
  const real = gitRun();
  return (args, cwd, opts) => {
    if (args.includes(word)) throw Object.assign(new Error('t'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
    return real(args, cwd, opts);
  };
}

test('a non-amend row has amendOf null', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-timeout');
  commitFiles(dir, { 'a.txt': lines(2) }, 'work', 1000);
  const one = resolveCommits({ dir, ...WINDOW, command: 'git commit -m work', run: gitRun() });
  assert.strictEqual(one.rows[0].amendOf, null);
});

test('patch-ids tell apart two patches whose bytes differ only where they are not UTF-8, and the log call passes --no-textconv', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  const idFor = (name, byte) => {
    const dir = initRepo(t, name);
    commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
    commitFiles(dir, { 'a.txt': Buffer.from([0x61, byte, 0x0a]) }, 'bytes', 1000);
    const calls = [];
    const real = gitRun();
    const run = (args, cwd, opts) => { calls.push(args); return real(args, cwd, opts); };
    const [row] = resolveCommits({ dir, ...WINDOW, command: 'git commit -m bytes', run }).rows;
    assert.ok(calls.some((a) => a.includes('-p') && a.includes('--no-textconv')));
    return row.patchId;
  };
  const a = idFor('commits-bytes-a', 0xff);
  const b = idFor('commits-bytes-b', 0xfe);
  assert.ok(a && b && a !== b);
});

test('a .gitattributes deleted by a later commit still marks the file generated for the earlier commit', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-attr-deleted');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  const first = commitFiles(dir, { '.gitattributes': 'gen.txt linguist-generated\n', 'gen.txt': lines(5) }, 'add generated', 1000);
  git(dir, ['rm', '-q', '.gitattributes'], 1001);
  git(dir, ['commit', '-q', '-m', 'drop attributes'], 1001);
  const row = resolveCommits({ dir, ...WINDOW, command: 'git commit -m "add generated"' }).rows.find((r) => r.sha === first);
  assert.deepStrictEqual(row.generated, ['gen.txt']);
  assert.strictEqual(row.added, 1, 'only .gitattributes counts');
});

test('a timeout in the check-attr step keeps the rows with no generated files and is transient and uncached', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  const dir = initRepo(t, 'commits-timeout-attr');
  commitFiles(dir, { 'a.txt': lines(2) }, 'work', 1000);
  resetCommitState();
  const res = resolveCommits({ dir, ...WINDOW, command: 'git commit -m work', run: slowOn('check-attr') });
  assert.strictEqual(res.transient, true);
  assert.strictEqual(res.rows.length, 1);
  assert.deepStrictEqual(res.rows[0].generated, []);
  assert.strictEqual(res.rows[0].added, 2);
  assert.strictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit -m work', run: gitRun() }).transient, false, 'a transient result is not cached');
});

test('a timeout in the patch-id step keeps the rows with patchId null and is transient', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  const dir = initRepo(t, 'commits-timeout-patchid');
  commitFiles(dir, { 'a.txt': lines(2) }, 'work', 1000);
  resetCommitState();
  const res = resolveCommits({ dir, ...WINDOW, command: 'git commit -m work', run: slowOn('patch-id') });
  assert.strictEqual(res.transient, true);
  assert.strictEqual(res.rows.length, 1);
  assert.strictEqual(res.rows[0].patchId, null);
  assert.strictEqual(res.rows[0].added, 2);
});

test('a timeout in the reflog step of a re-record keeps the rows unmarked and is transient', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  const dir = initRepo(t, 'commits-timeout-reflog');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  commitFiles(dir, { 'p.txt': lines(3) }, 'pre', 1000);
  git(dir, ['reset', '-q', '--soft', 'HEAD~1'], 1001);
  commitFiles(dir, { 'p.txt': lines(4) }, 'new', 1002);
  resetCommitState();
  const slow = (args, cwd, opts) => {
    if (args[0] === 'log' && args.includes('-g') && args.includes('--date=unix')) throw Object.assign(new Error('t'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
    return gitRun()(args, cwd, opts);
  };
  const res = resolveCommits({ dir, t0: 998_500, t1: 1_003_000, command: 'x', rerecordSince: 1_000_500, run: slow });
  assert.strictEqual(res.transient, true);
  assert.ok(res.rows.length > 0 && res.rows.every((r) => !r.squash));
});

test('a timeout in the main log query still returns no rows and is transient', { skip: !hasGit }, (t) => {
  t.after(resetCommitState);
  const dir = initRepo(t, 'commits-timeout-log');
  commitFiles(dir, { 'a.txt': lines(2) }, 'work', 1000);
  resetCommitState();
  assert.deepStrictEqual(resolveCommits({ dir, ...WINDOW, command: 'git commit -m work', run: slowOn('--numstat') }), { rows: [], transient: true });
});

test('resolveCommits reads a commit that an amend removed from every ref from the HEAD reflog', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-reflog');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  const c1 = commitFiles(dir, { 'b.txt': 'one\ntwo\n' }, 'work', 1000);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'one\ntwo\nthree\n');
  git(dir, ['add', '-A'], 5000);
  const env = { ...process.env, GIT_COMMITTER_DATE: '@5000 +0000' };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--amend', '--no-edit'], { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const { rows } = resolveCommits({ dir, t0: 999_500, t1: 1_000_400, command: 'git commit -m work' });
  assert.deepStrictEqual(rows.map((x) => x.sha), [c1]);
  assert.strictEqual(rows[0].fromReflog, true);
  assert.strictEqual(rows[0].added, 2);
});

test('resolveCommits returns [] when no reflog entry falls in the window', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-reflog-none');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m work' });
  assert.deepStrictEqual(rows, []);
});

test('a lone amend exempts the newest out-of-window commit', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-amend-newest');
  const gitAt = (args, author, committer) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `@${author} +0000`, GIT_COMMITTER_DATE: `@${committer} +0000` };
    const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  // The previous call's commit: committed at 1000 s, so the 1 s widening admits it, but authored at 500 s.
  fs.writeFileSync(path.join(dir, 'p.txt'), 'p\n');
  gitAt(['add', '-A'], 500, 1000);
  gitAt(['commit', '-q', '-m', 'previous'], 500, 1000);
  // This call's commit, authored at 400 s and amended at 1001 s.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  gitAt(['add', '-A'], 400, 1000);
  gitAt(['commit', '-q', '-m', 'work'], 400, 1000);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\ny\n');
  gitAt(['add', '-A'], 400, 1001);
  gitAt(['commit', '-q', '--amend', '--no-edit'], 400, 1001);
  const head = git(dir, ['rev-parse', 'HEAD'], 1001);
  const { rows } = resolveCommits({ dir, t0: 1_001_000, t1: 1_001_500, command: 'git commit --amend --no-edit' });
  assert.deepStrictEqual(rows.filter((x) => !x.rewrite).map((x) => x.sha), [head]);
  assert.strictEqual(rows.find((x) => x.sha !== head)?.rewrite, true, 'the previous call\'s commit is a rewrite row');
});

test('resolveCommits marks a reflog-recovered row of an --amend call as an amend', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-reflog-amend');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  commitFiles(dir, { 'b.txt': 'one\n' }, 'work', 1000);
  const env = { ...process.env, GIT_COMMITTER_DATE: '@1000 +0000' };
  for (const text of ['one\ntwo\n', 'one\ntwo\nthree\n']) {
    fs.writeFileSync(path.join(dir, 'b.txt'), text);
    git(dir, ['add', '-A'], 5000);
    const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--amend', '--no-edit'], { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: '@5000 +0000' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  const { rows } = resolveCommits({ dir, t0: 999_500, t1: 1_000_400, command: 'git commit --amend --no-edit' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].fromReflog, true);
  assert.strictEqual(rows[0].amend, true);
});

// Runs git with only the committer date set, so a rebase keeps each commit's author time.
function gitCommitterAt(dir, args, secs, extraEnv = {}) {
  const env = { ...process.env, GIT_COMMITTER_DATE: `@${secs} +0000`, ...extraEnv };
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('resolveCommits returns the copies a rebase made as rewrite rows', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-rewrite');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'side'], 100);
  commitFiles(dir, { 's.txt': lines(4) }, 'old work', 500);
  git(dir, ['checkout', '-q', 'main'], 600);
  const mine = commitFiles(dir, { 'm.txt': 'x\n' }, 'y', 1000);
  gitCommitterAt(dir, ['rebase', '-q', 'main', 'side'], 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git rebase main side' });
  const copy = rows.find((r) => r.subject === 'old work');
  assert.strictEqual(copy?.rewrite, true);
  assert.strictEqual(copy.added, 4);
  assert.ok(!rows.find((r) => r.sha === mine)?.rewrite);
});

test('resolveCommits returns a cherry-picked commit by another author as a rewrite row with its committer email', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-rewrite-other');
  commitFiles(dir, { 'base.txt': 'x\n' }, 'base', 100);
  git(dir, ['checkout', '-q', '-b', 'side'], 100);
  fs.writeFileSync(path.join(dir, 's.txt'), lines(4));
  git(dir, ['add', '-A'], 500);
  git(dir, ['commit', '-q', '-m', 'theirs', '--author', 'Other <other@e.x>'], 500);
  const theirs = git(dir, ['rev-parse', 'HEAD'], 500);
  git(dir, ['checkout', '-q', 'main'], 600);
  gitCommitterAt(dir, ['cherry-pick', theirs], 1000);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git cherry-pick ' + theirs });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].rewrite, true);
  assert.strictEqual(rows[0].authorEmail, 'other@e.x');
  assert.strictEqual(rows[0].committerEmail, 't@e.x');
  // lineRows drops it, because no counted row in the repo carries the author's email.
  assert.deepStrictEqual(lineRows([], rows.map((r) => ({ ...r, t: 2, sessionId: 's' }))), []);
});

test('resolveCommits returns a commit reachable from HEAD and a second one that was rewritten away', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-reflog-both');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  const second = commitFiles(dir, { 'b.txt': 'one\ntwo\n' }, 'second', 1000);
  git(dir, ['reset', '-q', '--hard', 'HEAD~1'], 1001);
  const first = commitFiles(dir, { 'c.txt': 'c\n' }, 'first', 1002);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git commit -m x' });
  assert.deepStrictEqual(rows.map((r) => r.sha).sort(), [first, second].sort());
  assert.strictEqual(rows.find((r) => r.sha === second).fromReflog, true);
  assert.ok(!rows.find((r) => r.sha === first).fromReflog);
});

test('a fast-forward merge in the window is not returned from the reflog', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-ff');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  // Another worktree makes the commit, so this checkout's HEAD reflog only lists it through the ff entry.
  const wt = path.join(helpers.tmpDir(t, 'commits-ff-wt'), 'wt');
  git(dir, ['worktree', 'add', '-q', '-b', 'other', wt], 100);
  commitFiles(wt, { 'o.txt': 'o\n' }, 'other work', 1000);
  git(dir, ['merge', '-q', '--ff-only', 'other'], 1001);
  git(dir, ['reset', '-q', '--hard', 'HEAD~1'], 1002);
  git(dir, ['worktree', 'remove', '--force', wt], 1002);
  git(dir, ['branch', '-q', '-D', 'other'], 1002);
  const { rows } = resolveCommits({ dir, ...WINDOW, command: 'git status' });
  assert.deepStrictEqual(rows, []);
});

test('resetEvents treats an unstage of a path or an existing folder as no state change', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-resetkind');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  fs.mkdirSync(path.join(dir, '.superpowers'));
  const kinds = (cmd) => resetEvents(`cd ${dir} && ${cmd}`, dir).map((e) => e.kind);
  assert.deepStrictEqual(kinds('git reset -q packages/solver/tests/diag_*.rs'), []);
  assert.deepStrictEqual(kinds('git reset -q .superpowers'), []);
  assert.deepStrictEqual(kinds('git reset -q'), []);
  assert.deepStrictEqual(kinds('git reset -q HEAD~2'), ['rerecord']);
  assert.deepStrictEqual(kinds('git reset -q abc1234'), ['rerecord']);
  assert.deepStrictEqual(kinds('git reset -q main'), ['rerecord']);
  assert.deepStrictEqual(kinds('git reset --soft'), []);
  assert.deepStrictEqual(kinds('git reset --soft x'), ['rerecord']);
});

test('markRerecord marks only commits after the reset and gives the last one the real new lines', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-rerecord');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  const before = commitFiles(dir, { 'f.txt': 'f\n' }, 'before', 999);
  commitFiles(dir, { 'p.txt': lines(3) }, 'pre', 1000);
  git(dir, ['reset', '-q', '--soft', 'HEAD~1'], 1001);
  const fresh = commitFiles(dir, { 'p.txt': lines(4) }, 'new', 1002);
  const { rows } = resolveCommits({ dir, t0: 998_500, t1: 1_003_000, command: 'x', rerecordSince: 1_000_500 });
  const byShaRows = new Map(rows.map((r) => [r.sha, r]));
  assert.ok(!byShaRows.get(before).squash, 'a commit made before the reset is not marked');
  assert.strictEqual(byShaRows.get(fresh).squash, true);
  assert.deepStrictEqual(byShaRows.get(fresh).rerecordDelta, { added: 1, removed: 0 });
  resetCommitState();
  const none = resolveCommits({ dir, t0: 998_500, t1: 1_003_000, command: 'x', rerecordSince: 5_000_000 });
  assert.ok(none.rows.length > 0 && none.rows.every((r) => !r.squash && !r.rerecordDelta), 'with no reset entry in range a checkout that exists leaves every row unmarked');
  resetCommitState();
  // A removed checkout is read through the main checkout, which has no reset entry in the
  // window of its own, so every row is marked and none has a delta.
  const gone = resolveCommits({ dir: `${dir}.wt`, t0: 998_500, t1: 1_003_000, command: 'x', rerecordSince: 5_000_000 });
  assert.ok(gone.rows.length > 0 && gone.rows.every((r) => r.squash === true && !r.rerecordDelta), 'with a removed checkout every row counts 0');
});

test('the last commit of a re-record sequence is found by ancestry when all commits share one second', { skip: !hasGit }, (t) => {
  const dir = initRepo(t, 'commits-rerecord-tip');
  commitFiles(dir, { 'a.txt': 'x\n' }, 'base', 100);
  commitFiles(dir, { 'p.txt': lines(3), 'q.txt': lines(2), 'r.txt': lines(1) }, 'pre', 1000);
  git(dir, ['reset', '-q', '--soft', 'HEAD~1'], 1001);
  git(dir, ['reset', '-q'], 1001);
  // Three layers in one committer second. Together they rebuild the pre-reset tree.
  const layer = (file, msg) => {
    git(dir, ['add', file], 1002);
    git(dir, ['commit', '-q', '-m', msg], 1002);
    return git(dir, ['rev-parse', 'HEAD'], 1002);
  };
  const first = layer('p.txt', 'one');
  const second = layer('q.txt', 'two');
  const tip = layer('r.txt', 'three');
  const { rows } = resolveCommits({ dir, t0: 998_500, t1: 1_003_000, command: 'x', rerecordSince: 1_000_500 });
  assert.deepStrictEqual(rows.find((r) => r.sha === tip).rerecordDelta, { added: 0, removed: 0 });
  assert.ok(rows.filter((r) => r.sha !== tip && r.squash).every((r) => !r.rerecordDelta));
  assert.ok([first, second].every((sha) => rows.find((r) => r.sha === sha)?.squash === true));
});
