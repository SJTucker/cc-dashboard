'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bashGroup, toolDetail } = require('../lib/transcript-lines');

test('bashGroup keeps the program and its first word or flag', () => {
  const cases = [
    ['sed -n 10,20p lib/extract.js', 'sed -n'],
    ['cd /Users/x/repo && git status', 'git status'],
    ['cd /Users/x/repo; grep -n foo lib/a.js', 'grep -n'],
    ['/usr/bin/git -C /Users/x/repo diff --stat', 'git diff'],
    ['git -c core.pager=cat show HEAD', 'git show'],
    ['FOO=1 npm test', 'npm test'],
    ['export A=1; cat -n file.txt', 'cat -n'],
    ['node test/x.js', 'node'],
    ['ls', 'ls'],
    ['rtk proxy pnpm vitest run', 'pnpm vitest'],
    ['rtk git diff', 'git diff'],
  ];
  for (const [command, group] of cases) assert.strictEqual(bashGroup(command), group, command);
});

test('bashGroup returns null when there is no command', () => {
  assert.strictEqual(bashGroup(''), null);
  assert.strictEqual(bashGroup(undefined), null);
  assert.strictEqual(bashGroup(42), null);
});

test('toolDetail still names the Bash program alone', () => {
  assert.strictEqual(toolDetail('Bash', { command: 'cd /r && /usr/bin/git -C /r diff' }), 'git');
});
