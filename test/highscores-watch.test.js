'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let W;
before(async () => { W = await import('../public/highscores/watch.mjs'); });

const S = (...k) => new Set(k);
test('the first poll only records the state', () => {
  assert.deepEqual(W.step(null, S('cost'), '2026-10-16', null).play, []);
});
test('a flip to first plays once, and not again the same day', () => {
  const a = W.step({ day: '2026-10-16', first: [] }, S('cost'), '2026-10-16', null);
  assert.deepEqual(a.play, ['cost']);
  const b = W.step({ day: '2026-10-16', first: [] }, S('cost'), '2026-10-16', a.celebrated);
  assert.deepEqual(b.play, []);
});
test('a new day resets the celebrated list', () => {
  const r = W.step({ day: '2026-10-17', first: [] }, S('cost'), '2026-10-17', { date: '2026-10-16', boards: ['cost'] });
  assert.deepEqual(r.play, ['cost']);
});
test('a poll from an earlier day only records the state', () => {
  assert.deepEqual(W.step({ day: '2026-10-15', first: [] }, S('cost'), '2026-10-16', null).play, []);
});
test('several boards flipping in one poll play together in board order', () => {
  assert.deepEqual(W.step({ day: '2026-10-16', first: [] }, S('turn', 'tokens'), '2026-10-16', null).play, ['tokens', 'turn']);
});
test('storage that throws reads null and writes nothing', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(W.readCelebrated(bad), null);
  assert.doesNotThrow(() => W.writeCelebrated(bad, { date: '2026-10-16', boards: ['cost'] }));
});
test('a malformed stored value reads null', () => {
  assert.equal(W.readCelebrated({ getItem: () => '{"date":1}' }), null);
});
test('a streak flip never plays, alone or with another board', () => {
  assert.deepEqual(W.step({ day: '2026-10-16', first: [] }, S('streak', 'cost'), '2026-10-16', null).play, ['cost']);
  assert.deepEqual(W.step({ day: '2026-10-16', first: [] }, S('streak'), '2026-10-16', null).play, []);
});
