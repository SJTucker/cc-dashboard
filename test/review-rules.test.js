'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const rules = require('../lib/review-rules');

const tmpDir = () => helpers.tmpDir(null, 'review-rules');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const names = (files) => files.map((f) => f.file);

test('includedPaths reads @path lines relative to the file, with ~ and $HOME expanded', () => {
  const text = 'intro\n@RTK.md\n  @./sub/a.md  \n@~/x.md\n@$HOME/y.md\n@/abs/z.md\nnot @inline.md\n@RTK.md\n';
  assert.deepStrictEqual(rules.includedPaths(text, '/cfg', '/home/u'), [
    '/cfg/RTK.md', '/cfg/sub/a.md', '/home/u/x.md', '/home/u/y.md', '/abs/z.md',
  ]);
});

test('ruleFiles reads the global CLAUDE.md, its includes, the project files outermost first, then the memory index', () => {
  const base = tmpDir();
  const cfg = path.join(base, 'cfg');
  write(path.join(cfg, 'CLAUDE.md'), 'global\n@RTK.md\n');
  write(path.join(cfg, 'RTK.md'), 'rtk rules');
  write(path.join(base, 'code', 'CLAUDE.md'), 'parent rules');
  write(path.join(base, 'code', 'app', 'CLAUDE.md'), 'app rules');
  write(path.join(base, 'code', 'app', 'CLAUDE.local.md'), 'local rules');
  const memory = write(path.join(cfg, 'projects', '-code-app', 'memory', 'MEMORY.md'), '- [A](a.md) — a fact');
  const files = rules.ruleFiles({ configDir: cfg, cwd: path.join(base, 'code', 'app'), memoryIndex: memory, home: base });
  assert.deepStrictEqual(names(files), [
    path.join(cfg, 'CLAUDE.md'),
    path.join(cfg, 'RTK.md'),
    path.join(base, 'code', 'CLAUDE.md'),
    path.join(base, 'code', 'app', 'CLAUDE.md'),
    path.join(base, 'code', 'app', 'CLAUDE.local.md'),
    memory,
  ]);
  assert.strictEqual(files[1].text, 'rtk rules');
});

test('ruleFiles skips missing files and folders', () => {
  const base = tmpDir();
  const cfg = path.join(base, 'cfg');
  write(path.join(cfg, 'CLAUDE.md'), '@missing.md\n@dir\n');
  fs.mkdirSync(path.join(cfg, 'dir'));
  const files = rules.ruleFiles({ configDir: cfg, cwd: path.join(base, 'gone'), memoryIndex: path.join(base, 'no', 'MEMORY.md'), home: base });
  assert.deepStrictEqual(names(files), [path.join(cfg, 'CLAUDE.md')]);
});

test('ruleFiles reads each file once through a cycle', () => {
  const base = tmpDir();
  write(path.join(base, 'CLAUDE.md'), '@b.md\n');
  write(path.join(base, 'b.md'), '@CLAUDE.md\n');
  assert.deepStrictEqual(names(rules.ruleFiles({ configDir: base, home: base })), [path.join(base, 'CLAUDE.md'), path.join(base, 'b.md')]);
});

test('ruleFiles lists the global file once when the session ran inside the config dir', () => {
  const base = tmpDir();
  write(path.join(base, 'CLAUDE.md'), 'global');
  const files = rules.ruleFiles({ configDir: base, cwd: base, home: base });
  assert.deepStrictEqual(names(files), [path.join(base, 'CLAUDE.md')]);
});

test('ruleFiles skips an empty file', () => {
  const base = tmpDir();
  write(path.join(base, 'CLAUDE.md'), '  \n');
  assert.deepStrictEqual(rules.ruleFiles({ configDir: base, home: base }), []);
});

test('ruleFiles with nothing to read returns an empty list', () => {
  assert.deepStrictEqual(rules.ruleFiles({}), []);
});

test('rulesText puts each file under its path', () => {
  assert.strictEqual(rules.rulesText([]), '');
  assert.strictEqual(
    rules.rulesText([{ file: '/a/CLAUDE.md', text: 'one\n' }, { file: '/b.md', text: 'two' }]),
    '=== /a/CLAUDE.md ===\none\n\n=== /b.md ===\ntwo',
  );
});

test('rulesText cuts at the limit and says how much', () => {
  const text = rules.rulesText([{ file: '/a', text: 'x'.repeat(100) }], 50);
  assert.strictEqual(text, `${'=== /a ===\n' + 'x'.repeat(39)}\n[... 61 characters cut ...]`);
});

test('reviewPrompt is the digest alone without rules, and puts rules first with them', () => {
  assert.strictEqual(rules.reviewPrompt('', 'USER: hi'), 'USER: hi');
  assert.strictEqual(rules.reviewPrompt('=== /a ===\nr', 'USER: hi'), 'RULES THE USER ALREADY HAS\n=== /a ===\nr\n\nSESSION DIGEST\nUSER: hi');
});

test('readSessionStart returns the first cwd and the first timestamp', async () => {
  const base = tmpDir();
  const file = write(path.join(base, 's.jsonl'), [
    JSON.stringify({ type: 'ai-title', aiTitle: 't' }),
    'not json "cwd"',
    JSON.stringify({ type: 'user', cwd: '/work/app', timestamp: '2026-10-13T10:00:00.000Z' }),
    JSON.stringify({ type: 'user', cwd: '/work/app/sub', timestamp: '2026-10-13T11:00:00.000Z' }),
  ].join('\n'));
  assert.deepStrictEqual(await rules.readSessionStart(file), { cwd: '/work/app', startedAt: Date.parse('2026-10-13T10:00:00.000Z') });
});

test('readSessionStart is all null when no line has a cwd or the file is missing', async () => {
  const base = tmpDir();
  const none = { cwd: null, startedAt: null };
  assert.deepStrictEqual(await rules.readSessionStart(write(path.join(base, 's.jsonl'), '{"type":"user"}\n')), none);
  assert.deepStrictEqual(await rules.readSessionStart(path.join(base, 'missing.jsonl')), none);
});

test('ruleFiles marks a file changed after the session started', () => {
  const base = tmpDir();
  const file = write(path.join(base, 'CLAUDE.md'), 'rule');
  const mtime = fs.statSync(file).mtimeMs;
  assert.deepStrictEqual(rules.ruleFiles({ configDir: base, home: base, startedAt: mtime - 1000 }).map((f) => f.changed), [true]);
  assert.deepStrictEqual(rules.ruleFiles({ configDir: base, home: base, startedAt: mtime + 1000 }).map((f) => f.changed), [false]);
  assert.deepStrictEqual(rules.ruleFiles({ configDir: base, home: base }).map((f) => f.changed), [false]);
});

test('rulesText says which files changed after the session started', () => {
  assert.strictEqual(
    rules.rulesText([{ file: '/a', text: 'one', changed: true }, { file: '/b', text: 'two', changed: false }]),
    '=== /a (changed after the session started) ===\none\n\n=== /b ===\ntwo',
  );
});

// A main checkout at main/ and a worktree of it at wt/, laid out the way git does.
function repoWithWorktree(base) {
  fs.mkdirSync(path.join(base, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
  write(path.join(base, 'main', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  write(path.join(base, 'wt', '.git'), `gitdir: ${path.join(base, 'main', '.git', 'worktrees', 'wt')}\n`);
  fs.mkdirSync(path.join(base, 'wt', 'sub'), { recursive: true });
}

const folderName = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

test('memoryIndexPath uses the main checkout memory for a worktree session', () => {
  const base = tmpDir();
  repoWithWorktree(base);
  const projects = path.join(base, 'projects');
  const memory = write(path.join(projects, folderName(path.join(base, 'main')), 'memory', 'MEMORY.md'), 'facts');
  const transcript = write(path.join(projects, folderName(path.join(base, 'wt', 'sub')), 's.jsonl'), '');
  assert.strictEqual(rules.memoryIndexPath({ projects, cwd: path.join(base, 'wt', 'sub'), transcript }), memory);
});

test('memoryIndexPath uses the repo root memory for a session in a subfolder of the main checkout', () => {
  const base = tmpDir();
  repoWithWorktree(base);
  const projects = path.join(base, 'projects');
  const memory = write(path.join(projects, folderName(path.join(base, 'main')), 'memory', 'MEMORY.md'), 'facts');
  fs.mkdirSync(path.join(base, 'main', 'lib'));
  const transcript = write(path.join(projects, folderName(path.join(base, 'main', 'lib')), 's.jsonl'), '');
  assert.strictEqual(rules.memoryIndexPath({ projects, cwd: path.join(base, 'main', 'lib'), transcript }), memory);
});

test('memoryIndexPath falls back to the folder next to the transcript', () => {
  const base = tmpDir();
  const projects = path.join(base, 'projects');
  const transcript = write(path.join(projects, '-work-demo', 's.jsonl'), '');
  const beside = path.join(projects, '-work-demo', 'memory', 'MEMORY.md');
  assert.strictEqual(rules.memoryIndexPath({ projects, cwd: path.join(base, 'not-a-repo'), transcript }), beside);
  assert.strictEqual(rules.memoryIndexPath({ projects, cwd: null, transcript }), beside);
  repoWithWorktree(base);
  assert.strictEqual(rules.memoryIndexPath({ projects, cwd: path.join(base, 'wt'), transcript }), beside);
});
