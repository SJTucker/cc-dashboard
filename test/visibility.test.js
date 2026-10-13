'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHidden, neededRequests } = require('../public/visibility');

const needed = (hidden, range) => [...neededRequests(new Set(hidden), range)].sort();

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

const NOW = ['records', 'sessions'];
const ANALYSIS = ['changes', 'prices', 'records', 'reviews', 'rtk'];

test('on Today (the Now tab) only the sessions and records requests are needed', () => {
  assert.deepStrictEqual(needed([], 'today'), NOW);
});

test('off Today (the Analysis tab) every request except sessions is needed', () => {
  for (const range of [7, 30, 90, 'all']) assert.deepStrictEqual(needed([], range), ANALYSIS, String(range));
});

test('a request shared by two panels stays needed until both are hidden', () => {
  assert.ok(neededRequests(new Set(['rtkDaily']), 7).has('rtk'));
  assert.ok(!neededRequests(new Set(['rtkDaily', 'rtkCommands']), 7).has('rtk'));
  assert.ok(neededRequests(new Set(['timeline']), 'today').has('sessions'));
  assert.ok(!neededRequests(new Set(['timeline', 'sessions']), 'today').has('sessions'));
});

test('a request with one panel is skipped when that panel is hidden', () => {
  assert.ok(!neededRequests(new Set(['reviews']), 30).has('reviews'));
  assert.ok(!neededRequests(new Set(['costByModel']), 30).has('prices'));
  assert.ok(!neededRequests(new Set(['beforeAfter']), 30).has('changes'));
});

test('records is needed on both tabs whatever is hidden, because the sticky bar uses it', () => {
  const everything = ['card-record', 'card-cost', 'card-tokens', 'beforeAfter', 'rtkDaily', 'rtkCommands', 'sessions', 'timeline', 'reviews', 'costByModel'];
  assert.ok(neededRequests(new Set(everything), 'today').has('records'));
  assert.ok(neededRequests(new Set(everything), 30).has('records'));
});

test('keys that feed no request change nothing', () => {
  assert.deepStrictEqual(needed(['dailyCost', 'tools', 'card-files', 'gone'], 'today'), NOW);
  assert.deepStrictEqual(needed(['dailyCost', 'tools', 'card-files', 'gone'], 7), ANALYSIS);
});
