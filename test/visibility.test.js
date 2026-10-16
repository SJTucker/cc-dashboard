'use strict';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert');
let parseHidden, neededRequests;
before(async () => { ({ parseHidden, neededRequests } = await import('../public/visibility.mjs')); });

const needed = (hidden, tab) => [...neededRequests(new Set(hidden), tab)].sort();

test('parseHidden returns the stored list of keys', () => {
  assert.deepStrictEqual(parseHidden('["dailyCost","card-cost"]'), ['dailyCost', 'card-cost']);
});

test('parseHidden returns an empty list for anything that is not a list of keys', () => {
  for (const raw of [null, '', 'not json', '{}', '"dailyCost"', '42', 'null']) {
    assert.deepStrictEqual(parseHidden(raw), [], String(raw));
  }
});

test('parseHidden drops entries that are not strings', () => {
  assert.deepStrictEqual(parseHidden('["dailyCost", 3, null, "tools"]'), ['dailyCost', 'tools']);
});

const NOW = ['prices', 'records', 'sessions'];
const ANALYSIS = ['changes', 'records', 'reviews', 'rtk'];

test('on the Now tab only the sessions, records and prices requests are needed', () => {
  assert.deepStrictEqual(needed([], 'now'), NOW);
});

test('on the Analysis tab, whatever its range (Today included, since the tab decides, not the range), every request except sessions and prices is needed', () => {
  assert.deepStrictEqual(needed([], 'analysis'), ANALYSIS);
});

test('a request shared by two panels stays needed until both are hidden', () => {
  assert.ok(neededRequests(new Set(['rtkDaily']), 'analysis').has('rtk'));
  assert.ok(!neededRequests(new Set(['rtkDaily', 'rtkCommands']), 'analysis').has('rtk'));
  assert.ok(neededRequests(new Set(['timeline']), 'now').has('sessions'));
  assert.ok(!neededRequests(new Set(['timeline', 'sessions']), 'now').has('sessions'));
});

test('a request with one panel is skipped when that panel is hidden', () => {
  assert.ok(!neededRequests(new Set(['reviews']), 'analysis').has('reviews'));
  assert.ok(!neededRequests(new Set(['costByModel']), 'now').has('prices'));
  assert.ok(!neededRequests(new Set(['beforeAfter']), 'analysis').has('changes'));
});

test('records is needed on both tabs whatever is hidden, because the sticky bar uses it', () => {
  const everything = ['card-record', 'card-cost', 'card-tokens', 'beforeAfter', 'rtkDaily', 'rtkCommands', 'sessions', 'timeline', 'reviews', 'costByModel'];
  assert.ok(neededRequests(new Set(everything), 'now').has('records'));
  assert.ok(neededRequests(new Set(everything), 'analysis').has('records'));
});

test('keys that feed no request change nothing', () => {
  assert.deepStrictEqual(needed(['dailyCost', 'tools', 'card-files', 'gone'], 'now'), NOW);
  assert.deepStrictEqual(needed(['dailyCost', 'tools', 'card-files', 'gone'], 'analysis'), ANALYSIS);
});

test('the High scores tab needs only /api/records', () => {
  assert.deepEqual(needed([], 'highscores'), ['records']);
});
