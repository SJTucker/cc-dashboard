'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { reviewPrompt, shortPath } = require('../public/reviews');

test('reviewPrompt names the transcript and lists each suggestion', () => {
  const review = { transcript: '/h/p/a.jsonl', suggestions: [{ kind: 'workflow', text: 'Plan first.' }, { kind: 'token-waste', text: 'Read once.' }] };
  assert.strictEqual(
    reviewPrompt(review),
    'Review the Claude Code session transcript at /h/p/a.jsonl. A Haiku review of it suggested:\n- Plan first.\n- Read once.\nWhich of these are right, which are wrong, and what did it miss?',
  );
});

test('reviewPrompt returns null without a transcript', () => {
  assert.strictEqual(reviewPrompt({ transcript: null, suggestions: [] }), null);
});

test('shortPath replaces a leading home directory with ~', () => {
  assert.strictEqual(shortPath('/Users/a/.claude/x.jsonl', '/Users/a'), '~/.claude/x.jsonl');
  assert.strictEqual(shortPath('/Users/a', '/Users/a'), '~');
  assert.strictEqual(shortPath('/Users/ab/x', '/Users/a'), '/Users/ab/x');
  assert.strictEqual(shortPath('/other/x', '/Users/a'), '/other/x');
  assert.strictEqual(shortPath('/other/x', undefined), '/other/x');
});
