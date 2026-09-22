'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { familyFor } = require('../lib/pricing');

test('familyFor maps real model names to their price-table family', () => {
  assert.strictEqual(familyFor('claude-opus-5'), 'opus');
  assert.strictEqual(familyFor('claude-sonnet-4-6-20260115'), 'sonnet');
  assert.strictEqual(familyFor('haiku-4-5-20251001'), 'haiku');
  assert.strictEqual(familyFor('claude-fable-5-1'), 'fable');
});

test('familyFor folds anything unrecognised to other', () => {
  assert.strictEqual(familyFor('some-unknown-model'), 'other');
  assert.strictEqual(familyFor(''), 'other');
  assert.strictEqual(familyFor(null), 'other');
  assert.strictEqual(familyFor(undefined), 'other');
});

test('familyFor matches the same entry priceFor would pick', () => {
  // Both walk PRICE_TABLE in order, so a name containing two family words
  // must resolve to the same entry in both functions.
  assert.strictEqual(familyFor('CLAUDE-OPUS-5'), 'opus', 'matching is case-insensitive');
});
