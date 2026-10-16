'use strict';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert');
let h;
before(async () => { h = await import('../public/reviews.mjs'); });

const open = (idx, text = `s${idx}`) => ({ idx, kind: 'workflow', text, dismissedAt: null, reason: null });
const closed = (idx, reason, text = `s${idx}`) => ({ idx, kind: 'workflow', text, dismissedAt: 1, reason });
const review = (sessionId, reviewedAt, suggestions, endedAt = reviewedAt) => ({ sessionId, reviewedAt, endedAt, transcript: `/t/${sessionId}.jsonl`, suggestions });

test('reviewPrompt names the transcript and lists the open suggestions only', () => {
  assert.strictEqual(
    h.reviewPrompt(review('a', 1, [open(0, 'Plan first.'), closed(1, 'done', 'Gone.'), open(2, 'Read once.')])),
    'Review the Claude Code session transcript at /t/a.jsonl. A Haiku review of it suggested:\n- Plan first.\n- Read once.\nWhich of these are right, which are wrong, and what did it miss?',
  );
});

test('reviewPrompt returns null without a transcript or without an open suggestion', () => {
  assert.strictEqual(h.reviewPrompt({ ...review('a', 1, [open(0)]), transcript: null }), null);
  assert.strictEqual(h.reviewPrompt(review('a', 1, [closed(0, 'done')])), null);
});

test('dismissalText and reasonLabel word every reason, expired included', () => {
  assert.deepStrictEqual(['done', 'duplicate', 'not_useful', 'expired'].map((r) => h.dismissalText({ reason: r })), ['Marked done', 'Marked duplicate', 'Marked not useful', 'Expired']);
  assert.deepStrictEqual(['done', 'duplicate', 'not_useful', 'expired'].map((r) => h.reasonLabel({ reason: r })), ['Done', 'Duplicate', 'Not useful', 'Expired']);
});

test('rangePhrase and rangeShort name each range', () => {
  assert.deepStrictEqual(['7', '30', '90', 'all'].map(h.rangePhrase), ['in the last 7 days', 'in the last 30 days', 'in the last 90 days', 'in all time']);
  assert.deepStrictEqual(['7', '30', '90', 'all'].map(h.rangeShort), ['7d', '30d', '90d', 'All']);
});

test('rangePhrase and rangeShort name the today range', () => {
  assert.strictEqual(h.rangePhrase('today'), 'today');
  assert.strictEqual(h.rangeShort('today'), 'Today');
});

test('countWithOpen counts reviews that still have an open suggestion', () => {
  assert.strictEqual(h.countWithOpen([review('a', 1, [open(0)]), review('b', 1, [closed(0, 'done')])]), 1);
});

test('byCursor orders newest reviewedAt first, then session id descending in byte order', () => {
  const sorted = [review('a', 5, []), review('B', 5, []), review('c', 9, [])].sort(h.byCursor).map((r) => r.sessionId);
  assert.deepStrictEqual(sorted, ['c', 'a', 'B']);
});

test('upsertSuggestion replaces a suggestion in place by idx', () => {
  const list = [review('a', 5, [open(0), open(1)])];
  const out = h.upsertSuggestion(list, list[0], closed(1, 'done'), { order: h.byEnd, insert: false });
  assert.deepStrictEqual(out[0].suggestions, [open(0), closed(1, 'done')]);
  assert.deepStrictEqual(list[0].suggestions, [open(0), open(1)], 'the input list is unchanged');
});

test('upsertSuggestion adds a suggestion to an entry that lacks it only when insert is set', () => {
  // A mixed review: its open half is in the open list. A closed suggestion relabelled
  // in the closed list must not appear in the open list's entry.
  const list = [review('a', 5, [open(0)])];
  assert.strictEqual(h.upsertSuggestion(list, list[0], closed(1, 'done'), { order: h.byEnd, insert: false }), list);
  assert.deepStrictEqual(h.upsertSuggestion(list, list[0], open(1), { order: h.byEnd, insert: true })[0].suggestions, [open(0), open(1)]);
});

test('upsertSuggestion adds a missing review in order only when insert is set', () => {
  const list = [review('new', 9, [closed(0, 'done')]), review('old', 1, [closed(0, 'done')])];
  const mid = review('mid', 5, [open(0), open(1)]);
  assert.strictEqual(h.upsertSuggestion(list, mid, open(1), { order: h.byCursor, insert: false }), list);
  const out = h.upsertSuggestion(list, mid, closed(1, 'duplicate'), { order: h.byCursor, insert: true });
  assert.deepStrictEqual(out.map((r) => [r.sessionId, r.suggestions.map((s) => s.idx)]), [['new', [0]], ['mid', [1]], ['old', [0]]]);
});

test('upsertSuggestion leaves a review past the last loaded one for its own page while more pages remain', () => {
  const list = [review('new', 9, [closed(0, 'done')])];
  const older = review('older', 1, [open(0)]);
  assert.strictEqual(h.upsertSuggestion(list, older, closed(0, 'done'), { order: h.byCursor, insert: true, hasMore: true }), list);
  assert.deepStrictEqual(h.upsertSuggestion(list, older, closed(0, 'done'), { order: h.byCursor, insert: true, hasMore: false }).map((r) => r.sessionId), ['new', 'older']);
});
