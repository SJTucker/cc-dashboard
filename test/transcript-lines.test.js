'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bashGroup, toolDetail, handoffTitle, handoffHeading, handoffPromptPath, promptText, isTypedPrompt, isUntaggedPrompt } = require('../lib/transcript-lines');

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

test('handoffTitle cuts at the earliest separator and capitalises', () => {
  const cases = [
    ['PR #296 (refactor/split-entity-inspector) — review follow-ups, Sonar fix', 'PR #296'],
    ['Audit how stale the f-forge architecture atlas is, then automate keeping it in sync', 'Audit how stale the f-forge architecture atlas is'],
    ['fix the post-merge Deploy failure on master; PR open', 'Fix the post-merge Deploy failure on master'],
    ['Fix the deploy', 'Fix the deploy'],
  ];
  for (const [heading, want] of cases) assert.strictEqual(handoffTitle(heading), want);
});

test('handoffTitle caps a long heading like promptPreview', () => {
  const out = handoffTitle('word '.repeat(40));
  assert.strictEqual(out.length, 80);
  assert.ok(out.endsWith('…'));
});

test('handoffHeading strips the line-number prefix and ignores other lines', () => {
  assert.strictEqual(handoffHeading('     1\t# Handoff: fix it\n     2\tbody'), 'fix it');
  assert.strictEqual(handoffHeading('     1\t# Something else'), null);
});

test('handoffPromptPath returns the .claude/handoffs tail of an absolute or relative path', () => {
  assert.strictEqual(handoffPromptPath('Read /a/b/.claude/handoffs/x.md, check Preconditions'), '.claude/handoffs/x.md');
  assert.strictEqual(handoffPromptPath('Read .claude/handoffs/x.md, check'), '.claude/handoffs/x.md');
  assert.strictEqual(handoffPromptPath('Read notes/x.md, check'), null);
  assert.strictEqual(handoffPromptPath('fix the bug'), null);
});

const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const typedLine = (content, extra = {}) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content }, ...extra });

test('promptText returns a string as is, joins the text blocks of text and image content, and returns null for anything else', () => {
  assert.strictEqual(promptText('hello'), 'hello');
  assert.strictEqual(promptText([{ type: 'text', text: 'look [Image #1]' }, imageBlock]), 'look [Image #1]');
  assert.strictEqual(promptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.strictEqual(promptText([imageBlock]), null);
  assert.strictEqual(promptText([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), null);
  assert.strictEqual(promptText([{ type: 'text', text: 'a' }, { type: 'tool_result', tool_use_id: 't', content: 'x' }]), null);
  assert.strictEqual(promptText(undefined), null);
});

test('a typed prompt with a pasted image is a typed prompt', () => {
  assert.strictEqual(isTypedPrompt(typedLine([{ type: 'text', text: 'investigate [Image #3]' }, imageBlock])), true);
});

test('the isMeta companion line that names the image path is not a typed prompt', () => {
  const companion = typedLine([{ type: 'text', text: '[Image: source: /tmp/3.png]' }], { isMeta: true, turnCompanion: true });
  assert.strictEqual(isTypedPrompt(companion), false);
});

test('a tool_result array line is not a typed prompt or an untagged prompt', () => {
  const line = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } };
  assert.strictEqual(isTypedPrompt({ ...line, origin: { kind: 'human' }, promptSource: 'typed' }), false);
  assert.strictEqual(isUntaggedPrompt(line), false);
});

test('an untagged line with text and image content is an untagged prompt', () => {
  assert.strictEqual(isUntaggedPrompt({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }, imageBlock] } }), true);
});
