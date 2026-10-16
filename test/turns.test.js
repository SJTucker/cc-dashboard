'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { longestTurns, TURN_LIMIT } = require('../lib/turns');

const MIN = 60_000;
const turn = (t, durationMs, sessionId = 's1') => ({ t, durationMs, sessionId });
const call = (t, cost, sessionId = 's1') => ({ t, cost, sessionId });

test('turns come longest first with their calls, cost and title', () => {
  const turns = [turn(10 * MIN, 2 * MIN), turn(60 * MIN, 30 * MIN, 's2')];
  const calls = [call(9 * MIN, 1), call(10 * MIN, 2), call(7 * MIN, 99), call(40 * MIN, 5, 's2'), call(50 * MIN, 5, 's1')];
  const titles = new Map([['s1', 'Fix the parser']]);
  const firstPrompts = new Map([['s2', 'look at ideas']]);
  assert.deepStrictEqual(longestTurns(turns, calls, titles, firstPrompts), [
    { t: 60 * MIN, start: 30 * MIN, sessionId: 's2', durationMs: 30 * MIN, calls: 1, cost: 5, title: 'look at ideas' },
    { t: 10 * MIN, start: 8 * MIN, sessionId: 's1', durationMs: 2 * MIN, calls: 2, cost: 3, title: 'Fix the parser' },
  ]);
});

test('a turn with no calls and no title still shows', () => {
  assert.deepStrictEqual(longestTurns([turn(5, 5, 'sx')], [], new Map(), new Map()), [
    { t: 5, start: 0, sessionId: 'sx', durationMs: 5, calls: 0, cost: 0, title: null },
  ]);
});

test('at most TURN_LIMIT turns are returned', () => {
  const turns = Array.from({ length: TURN_LIMIT + 3 }, (_, i) => turn(1000 + i, i + 1));
  const out = longestTurns(turns, [], new Map(), new Map());
  assert.strictEqual(out.length, TURN_LIMIT);
  assert.strictEqual(out[0].durationMs, TURN_LIMIT + 3);
});

test('a handoff title beats the ai-title and the first prompt', () => {
  const out = longestTurns([turn(5, 5)], [], new Map([['s1', 'ai']]), new Map([['s1', 'prompt']]), new Map([['s1', 'Fix the deploy failure']]));
  assert.strictEqual(out[0].title, 'Fix the deploy failure');
});
