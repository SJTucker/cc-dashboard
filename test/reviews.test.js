'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { reviewPrompt, shortPath, openSuggestions, dismissedSuggestions, allDismissed, countWithOpen, dismissalText } = require('../public/reviews');

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

test('reviewPrompt words a review with no suggestions or a failed review', () => {
  const ask = 'What would you suggest, and why might Haiku have missed it?';
  assert.strictEqual(
    reviewPrompt({ transcript: '/h/a.jsonl', status: 'done', suggestions: [] }),
    `Review the Claude Code session transcript at /h/a.jsonl. A Haiku review of it made no suggestions.\n${ask}`,
  );
  assert.strictEqual(
    reviewPrompt({ transcript: '/h/a.jsonl', status: 'failed', suggestions: [] }),
    `Review the Claude Code session transcript at /h/a.jsonl. A Haiku review of it failed.\n${ask}`,
  );
});

const sug = (idx, text, reason = null) => ({ idx, kind: 'workflow', text, dismissedAt: reason ? 5 : null, reason });

test('openSuggestions and dismissedSuggestions split on dismissedAt, and a suggestion without the field is open', () => {
  const review = { suggestions: [sug(0, 'a'), sug(1, 'b', 'done'), { kind: 'workflow', text: 'c' }] };
  assert.deepStrictEqual(openSuggestions(review).map((s) => s.text), ['a', 'c']);
  assert.deepStrictEqual(dismissedSuggestions(review).map((s) => s.text), ['b']);
});

test('allDismissed is false for no suggestions and for a mix, true only when none is open', () => {
  assert.strictEqual(allDismissed({ suggestions: [] }), false);
  assert.strictEqual(allDismissed({ suggestions: [sug(0, 'a'), sug(1, 'b', 'done')] }), false);
  assert.strictEqual(allDismissed({ suggestions: [sug(0, 'a', 'done'), sug(1, 'b', 'not_useful')] }), true);
});

test('countWithOpen counts reviews with at least one open suggestion', () => {
  const reviews = [
    { suggestions: [sug(0, 'a')] },
    { suggestions: [sug(0, 'a', 'done'), sug(1, 'b')] },
    { suggestions: [sug(0, 'a', 'done')] },
    { suggestions: [] },
  ];
  assert.strictEqual(countWithOpen(reviews), 2);
});

test('dismissalText says the reason in words', () => {
  assert.strictEqual(dismissalText(sug(0, 'a', 'done')), 'Marked done');
  assert.strictEqual(dismissalText(sug(0, 'a', 'not_useful')), 'Marked not useful');
});

test('reviewPrompt leaves out dismissed suggestions', () => {
  const review = { transcript: '/h/a.jsonl', status: 'done', suggestions: [sug(0, 'Keep me'), sug(1, 'Drop me', 'not_useful'), sug(2, 'Me too')] };
  assert.strictEqual(
    reviewPrompt(review),
    'Review the Claude Code session transcript at /h/a.jsonl. A Haiku review of it suggested:\n- Keep me\n- Me too\nWhich of these are right, which are wrong, and what did it miss?',
  );
});

test('reviewPrompt returns null when every suggestion is dismissed', () => {
  assert.strictEqual(reviewPrompt({ transcript: '/h/a.jsonl', status: 'done', suggestions: [sug(0, 'a', 'done')] }), null);
});
