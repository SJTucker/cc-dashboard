'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { encodeFolder, findRepo, repoFromProjectFolder, projectFolderOf } = require('../lib/repo');

// os.tmpdir() on macOS sits under /var, a symlink to /private/var. The folder walk
// skips symlinks, so fixtures live under the real path.
function base(t) {
  return fs.realpathSync(helpers.tmpDir(t, 'repo'));
}

// A main checkout at <root>/code/app with a .git folder, and a worktree at
// <root>/code/app.feature whose .git file points into the main checkout.
function layout(root) {
  const main = path.join(root, 'code', 'app');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'app.feature'), { recursive: true });
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  const worktree = path.join(root, 'code', 'app.feature');
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'app.feature')}\n`);
  return { main, worktree };
}

test('encodeFolder replaces every character other than a letter or digit with -', () => {
  assert.strictEqual(encodeFolder('/Users/bing/code/f-forge/.claude/worktrees/x_y'), '-Users-bing-code-f-forge--claude-worktrees-x-y');
});

test('findRepo returns the folder that holds a .git folder', (t) => {
  const { main } = layout(base(t));
  assert.strictEqual(findRepo(path.join(main, 'src')), main);
  assert.strictEqual(findRepo(main), main);
});

test('findRepo returns the main checkout for a worktree whose .git file points at .git/worktrees', (t) => {
  const { main, worktree } = layout(base(t));
  assert.strictEqual(findRepo(path.join(worktree, 'src')), main);
});

test('findRepo treats a .git file with another gitdir, or none, as its own repo', (t) => {
  const root = base(t);
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../outer/.git/modules/sub\n');
  const odd = path.join(root, 'odd');
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, '.git'), 'not a gitdir line\n');
  assert.strictEqual(findRepo(sub), sub);
  assert.strictEqual(findRepo(odd), odd);
});

test('findRepo reaches the main checkout from a deleted .claude/worktrees folder', (t) => {
  const { main } = layout(base(t));
  assert.strictEqual(findRepo(path.join(main, '.claude', 'worktrees', 'gone', 'src')), main);
});

test('findRepo maps a deleted worktrunk folder <a>.<b> to its sibling <a>', (t) => {
  const { main } = layout(base(t));
  assert.strictEqual(findRepo(path.join(path.dirname(main), 'app.deleted-branch', 'src')), main);
});

test('findRepo returns null outside any repo, and for a relative or missing start', (t) => {
  const root = base(t);
  fs.mkdirSync(path.join(root, 'plain'));
  assert.strictEqual(findRepo(path.join(root, 'plain')), null);
  assert.strictEqual(findRepo('relative/path'), null);
  assert.strictEqual(findRepo(undefined), null);
});

test('findRepo resolves a path written through a symlinked parent', (t) => {
  const root = base(t);
  layout(root);
  const link = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'code'), link);
  assert.strictEqual(findRepo(path.join(link, 'app', 'src')), path.join(link, 'app'));
});

test('repoFromProjectFolder finds the repo of a deleted .claude/worktrees session', (t) => {
  const root = base(t);
  const { main } = layout(root);
  const folder = encodeFolder(path.join(main, '.claude', 'worktrees', 'gone'));
  assert.strictEqual(repoFromProjectFolder(folder, root), main);
});

test('repoFromProjectFolder resolves an existing worktree folder to its main checkout', (t) => {
  const root = base(t);
  const { main, worktree } = layout(root);
  assert.strictEqual(repoFromProjectFolder(encodeFolder(worktree), root), main);
});

test('repoFromProjectFolder returns null when no folder on the path holds .git', (t) => {
  const root = base(t);
  layout(root);
  assert.strictEqual(repoFromProjectFolder(encodeFolder(path.join(root, 'code', 'elsewhere')), root), null);
});

test('projectFolderOf takes the folder under projects, for main and subagent transcripts', () => {
  assert.strictEqual(projectFolderOf('/u/.claude/projects/-u-code-app/abc.jsonl'), '-u-code-app');
  assert.strictEqual(projectFolderOf('/u/.claude/projects/-u-code-app/abc/subagents/agent-1.jsonl'), '-u-code-app');
  assert.strictEqual(projectFolderOf('/u/elsewhere/abc.jsonl'), null);
});
