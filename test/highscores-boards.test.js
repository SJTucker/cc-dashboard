'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
let B;
before(async () => { B = await import('../public/highscores/boards.mjs'); });

const e = (id, score, at, extra = {}) => ({ id, date: id.slice(0, 10), at, score, ...extra });
const live = (over = {}) => ({ date: '2026-10-16', tokens: 0, cost: 0, prompts: 0, sessions: 0, linesAdded: 0, linesRemoved: 0, sessionCosts: [], turns: [], ...over });
const payload = (boards, over = {}) => ({ date: '2026-10-16', boards, currentRun: null, carry: {}, ...over });

test('BOARDS lists nine boards in order with their titles', () => {
  assert.deepEqual(B.BOARDS.map((b) => b.key), ['tokens', 'cost', 'prompts', 'sessions', 'linesAdded', 'linesRemoved', 'session', 'turn', 'streak']);
  assert.equal(B.BOARDS[5].title, 'LINES DELETED IN ONE DAY');
  assert.equal(B.BOARDS[8].hall, 'STREAK');
});

test('rankEntries drops zero scores, breaks ties by the earlier entry and keeps 10', () => {
  const list = [e('2026-10-01', 5, 1), e('2026-10-02', 5, 0), e('2026-10-03', 0, 2), ...Array.from({ length: 12 }, (_, i) => e(`2026-09-${String(i + 10)}`, 1, 10 + i))];
  const ranked = B.rankEntries(list);
  assert.equal(ranked.length, 10);
  assert.deepEqual(ranked.slice(0, 2).map((x) => x.id), ['2026-10-02', '2026-10-01']);
  assert.ok(!ranked.some((x) => x.score === 0));
});

test('mergeToday adds today to a day board, marks it and re-ranks', () => {
  const m = B.mergeToday(payload({ tokens: [e('2026-10-15', 100, 1)] }), live({ tokens: 150 }), '2026-10-16');
  assert.deepEqual(m.tokens.map((x) => [x.id, x.today === true]), [['2026-10-16', true], ['2026-10-15', false]]);
});

test('mergeToday returns null for a payload built on an earlier date', () => {
  assert.equal(B.mergeToday(payload({}, { date: '2026-10-15' }), live(), '2026-10-16'), null);
});

test('a tie with an earlier day keeps the earlier day first', () => {
  const m = B.mergeToday(payload({ cost: [e('2026-10-15', 10, 1)] }), live({ cost: 10 }), '2026-10-16');
  assert.equal(m.cost[0].id, '2026-10-15');
  assert.equal(B.todayFirstKeys(m).has('cost'), false);
});

test('a session active today scores its carry plus today and keeps its start date', () => {
  const p = payload({ session: [e('2026-10-10', 50, 1)] }, { carry: { s1: { cost: 30, at: Date.parse('2026-10-15T23:00:00') } } });
  const m = B.mergeToday(p, live({ sessionCosts: [{ sessionId: 's1', cost: 25, at: Date.parse('2026-10-16T00:10:00'), title: 'Fix it' }] }), '2026-10-16');
  assert.deepEqual([m.session[0].id, m.session[0].score, m.session[0].date, m.session[0].today], ['s1', 55, '2026-10-15', true]);
});

test('several of today\'s turns can be on the turn board', () => {
  const t = Date.parse('2026-10-16T12:00:00');
  const m = B.mergeToday(payload({ turn: [e('2026-10-01', 1000, 1)] }), live({ turns: [{ sessionId: 'a', t, durationMs: 5000, title: null }, { sessionId: 'b', t: t + 1, durationMs: 3000, title: null }] }), '2026-10-16');
  assert.equal(m.turn.filter((x) => x.today).length, 2);
});

test('the streak board extends the run that ended yesterday, only with tokens today', () => {
  const p = payload({ streak: [{ id: '2026-10-10', date: '2026-10-10', end: '2026-10-15', at: 1, score: 6 }] }, { currentRun: { start: '2026-10-10', end: '2026-10-15', days: 6 } });
  assert.deepEqual(B.mergeToday(p, live({ tokens: 1 }), '2026-10-16').streak.map((x) => [x.id, x.score, x.end, x.today === true]), [['2026-10-10', 7, '2026-10-16', true]]);
  assert.deepEqual(B.mergeToday(p, live({ tokens: 0 }), '2026-10-16').streak.map((x) => x.score), [6]);
});

test('todayFirstKeys needs an earlier entry to beat', () => {
  const m = B.mergeToday(payload({ turn: [] }), live({ turns: [{ sessionId: 'a', t: Date.parse('2026-10-16T09:00:00'), durationMs: 9, title: null }] }), '2026-10-16');
  assert.equal(B.todayFirstKeys(m).has('turn'), false);
});
