'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHidden, neededRequests } = require('../public/visibility');

const ALL = ['changes', 'rtk', 'sessions', 'reviews', 'records', 'prices'];
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

test('with nothing hidden every optional request is needed on Today', () => {
  assert.deepStrictEqual(needed([], 'today'), [...ALL].sort());
});

test('off Today the sessions request is never needed', () => {
  for (const range of [7, 30, 90, 'all']) {
    assert.ok(!neededRequests(new Set(), range).has('sessions'), String(range));
  }
});

test('a request shared by two panels stays needed until both are hidden', () => {
  assert.ok(neededRequests(new Set(['sessionStart']), 'today').has('changes'));
  assert.ok(!neededRequests(new Set(['sessionStart', 'beforeAfter']), 'today').has('changes'));
  assert.ok(neededRequests(new Set(['rtkDaily']), 7).has('rtk'));
  assert.ok(!neededRequests(new Set(['rtkDaily', 'rtkCommands']), 7).has('rtk'));
  assert.ok(neededRequests(new Set(['timeline']), 'today').has('sessions'));
  assert.ok(!neededRequests(new Set(['timeline', 'sessions']), 'today').has('sessions'));
});

test('a request with one panel is skipped when that panel is hidden', () => {
  assert.ok(!neededRequests(new Set(['reviews']), 30).has('reviews'));
  assert.ok(!neededRequests(new Set(['costByModel']), 30).has('prices'));
});

test('records is needed for the Record day card, and on Today for the 7d total lines', () => {
  assert.ok(neededRequests(new Set(), 7).has('records'));
  assert.ok(!neededRequests(new Set(['card-record']), 7).has('records'), 'off Today only Record day uses it');
  assert.ok(neededRequests(new Set(['card-record']), 'today').has('records'), 'Total cost and Total tokens show the 7d lines');
  assert.ok(neededRequests(new Set(['card-record', 'card-cost']), 'today').has('records'));
  assert.ok(!neededRequests(new Set(['card-record', 'card-cost', 'card-tokens']), 'today').has('records'));
});

test('keys that feed no request change nothing', () => {
  assert.deepStrictEqual(needed(['dailyCost', 'tools', 'card-files', 'gone'], 'today'), [...ALL].sort());
});
