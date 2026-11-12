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
