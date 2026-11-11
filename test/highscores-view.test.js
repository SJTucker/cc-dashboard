'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let V;
test.before(async () => {
  V = { ...(await import('../public/highscores/view.mjs')), ...(await import('../public/highscores/scene.mjs')) };
});

test('dayLabel adds the year only outside the current year', () => {
  assert.equal(V.dayLabel('2026-10-15', 2026), 'OCT 15');
  assert.equal(V.dayLabel('2025-10-15', 2026), "OCT 15 '25");
});
test('scoreText formats each board', () => {
  assert.equal(V.scoreText('tokens', { score: 1292566482 }), '1,292,566,482');
  assert.equal(V.scoreText('cost', { score: 466.0929 }), '$466.09');
  assert.equal(V.scoreText('cost', { score: 1234.56 }), '$1,234.56');
  assert.equal(V.scoreText('session', { score: 12345.6 }), '$12,345.60');
  assert.equal(V.scoreText('linesAdded', { score: 8412 }), '+8,412');
  assert.equal(V.scoreText('linesRemoved', { score: 5120 }), '−5,120');
  assert.equal(V.scoreText('turn', { score: 2832000 }), '47m 12s');
  assert.equal(V.scoreText('turn', { score: 3780000 }), '1h 03m');
  assert.equal(V.scoreText('streak', { score: 29 }), '29 DAYS');
});
test('boardRows marks first, today and the streak range', () => {
  const rows = V.boardRows('streak', [{ id: '2026-09-18', date: '2026-09-18', end: '2026-10-16', at: 0, score: 29, today: true }], 2026);
  assert.deepEqual(rows[0], { rank: '01', crown: true, day: 'SEP 18→OCT 16', title: null, score: '29 DAYS', first: true, today: true });
});
test('boardRows says TODAY only on day boards', () => {
  const e = [{ id: 'a', date: '2026-10-16', at: 1, score: 5, today: true, title: 'T' }, { id: 'b', date: '2026-10-01', at: 0, score: 4 }];
  const day = V.boardRows('tokens', e, 2026);
  assert.equal(day[0].day, 'TODAY');
  assert.equal(day[1].day, 'OCT 01');
  assert.equal(day[1].rank, '02');
  assert.equal(day[1].crown, false);
  assert.equal(V.boardRows('session', e, 2026)[0].day, 'OCT 16');
  assert.equal(V.boardRows('session', e, 2026)[0].title, 'T');
});
test('hallRows gives a dash for an empty board', () => {
  const rows = V.hallRows({ tokens: [] }, 2026);
  assert.equal(rows.length, 9);
  assert.deepEqual([rows[0].label, rows[0].day, rows[0].score], ['TOKENS', '—', '—']);
  assert.equal(V.hallRows({ cost: [{ id: 'x', date: '2025-01-02', at: 0, score: 3.5 }] }, 2026)[1].score, '$3.50');
});
test('stickyRecord gives a compact value and a dated note for each kind of board', () => {
  const today = '2026-10-16';
  assert.deepEqual(V.stickyRecord('tokens', { date: '2026-10-15', score: 1292566482 }, today), { label: 'Record tokens', value: '1.29B', note: '10/15' });
  assert.deepEqual(V.stickyRecord('cost', { date: today, score: 466.0929, today: true }, today), { label: 'Record cost', value: '$466.09', note: 'today' });
  assert.equal(V.stickyRecord('session', { date: '2026-10-01', score: 12.5, title: 'Fix the parser' }, today).note, '10/1 · Fix the parser');
  assert.equal(V.stickyRecord('turn', { date: '2026-10-01', score: 2832000 }, today).value, '47m 12s');
  assert.equal(V.stickyRecord('streak', { date: '2026-09-18', end: today, score: 29 }, today).note, '9/18–today');
  assert.equal(V.stickyRecord('streak', { date: '2026-09-18', end: '2026-09-18', score: 1 }, today).note, '9/18');
});
test('seededRandom repeats for the same seed', () => {
  const a = V.seededRandom(7), b = V.seededRandom(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const v = a();
  assert.ok(v >= 0 && v < 1);
});
