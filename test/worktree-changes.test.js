'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, git, gitRepo } = require('./helpers');
const { changedSince, worktreeBase } = require('../lib/worktree-changes');

test('changedSince lists edited, committed and untracked files, and skips ignored ones', (t) => {
  const dir = gitRepo(t);
  const { head } = worktreeBase(dir);
  fs.writeFileSync(path.join(dir, 'lib/a.js'), 'changed');
  fs.writeFileSync(path.join(dir, 'lib/new.js'), 'new');
  // Edited and committed in one go, as a Bash command can do.
  fs.writeFileSync(path.join(dir, 'lib/b.js'), 'b');
  git(dir, 'add', 'lib/b.js');
  git(dir, 'commit', '-qm', 'b');
  fs.mkdirSync(path.join(dir, 'target'));
  fs.writeFileSync(path.join(dir, 'target/out'), 'x');
  assert.deepEqual(changedSince(dir, head), ['lib/a.js', 'lib/b.js', 'lib/new.js'].map((f) => path.join(dir, f)));
});

test('worktreeBase records changes already present', (t) => {
  const dir = gitRepo(t);
  fs.writeFileSync(path.join(dir, 'lib/a.js'), 'changed');
  assert.deepEqual([...worktreeBase(dir).before], [path.join(dir, 'lib/a.js')]);
});

test('changedSince and worktreeBase return null outside a repo or for a missing folder', (t) => {
  const dir = tmpDir(t, 'not-a-repo');
  assert.equal(worktreeBase(dir), null);
  assert.equal(changedSince(path.join(dir, 'gone'), 'HEAD'), null);
});

test('changedSince leaves out files a merge of another branch brought in', (t) => {
  const dir = gitRepo(t);
  const task = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const { head } = worktreeBase(dir);
  // The plan branch gets a fix after the watch took its base, and the worktree fast-forwards to it.
  git(dir, 'checkout', '-qb', 'plan');
  fs.writeFileSync(path.join(dir, 'lib/shared.js'), 'fix');
  git(dir, 'add', 'lib/shared.js');
  git(dir, 'commit', '-qm', 'fix');
  git(dir, 'checkout', '-q', task);
  git(dir, 'merge', '-q', '--ff-only', 'plan');
  assert.deepEqual(changedSince(dir, head), []);
  // The worker's own commit after the merge still counts.
  fs.writeFileSync(path.join(dir, 'lib/c.js'), 'c');
  git(dir, 'add', 'lib/c.js');
  git(dir, 'commit', '-qm', 'c');
  assert.deepEqual(changedSince(dir, head), [path.join(dir, 'lib/c.js')]);
});

test('changedSince does not rewrite the index', (t) => {
  const dir = gitRepo(t);
  const { head } = worktreeBase(dir);
  const index = path.join(dir, '.git/index');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(index, old, old);
  // Same content, new timestamp: a git command that refreshes the index would rewrite it.
  fs.writeFileSync(path.join(dir, 'lib/a.js'), 'a');
  changedSince(dir, head);
  assert.equal(fs.statSync(index).mtimeMs, old.getTime());
});

test('changedSince returns null for a folder inside a repo that is not itself a worktree', (t) => {
  const dir = gitRepo(t);
  fs.mkdirSync(path.join(dir, 'lib/stale'));
  fs.writeFileSync(path.join(dir, 'lib/a.js'), 'changed');
  assert.equal(changedSince(path.join(dir, 'lib/stale'), 'HEAD'), null);
  assert.equal(worktreeBase(path.join(dir, 'lib/stale')), null);
});

test('changedSince returns absolute paths for a relative worktree', (t) => {
  const dir = gitRepo(t);
  const { head } = worktreeBase(dir);
  fs.writeFileSync(path.join(dir, 'lib/c.js'), 'c');
  assert.deepEqual(changedSince(path.relative(process.cwd(), dir), head), [path.join(dir, 'lib/c.js')]);
});
