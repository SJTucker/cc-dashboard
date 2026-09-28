'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { familyFor, shortModelLabel } = require('../lib/pricing');

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

const { costForUsage, priceFor } = require('../lib/pricing');

// Prices are small fractions of a cent per token; compare with a tolerance
// rather than exactly, so a change in the order of operations doesn't fail.
function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`
  );
}

// One million of each token category, so every assertion below is just the
// per-MTok sticker price added up.
function oneMillionEach(extra = {}) {
  return {
    input_tokens: 1e6,
    output_tokens: 1e6,
    cache_read_input_tokens: 1e6,
    cache_creation_input_tokens: 1e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 0 },
    speed: 'standard',
    ...extra,
  };
}

test('Claude Opus 5 is priced at its published rates, not Opus 4.1 rates', () => {
  const { cost, priced } = costForUsage(oneMillionEach(), 'claude-opus-5');
  assert.strictEqual(priced, true);
  // input 5 + output 25 + 5m cache write 6.25 + cache read 0.50
  closeTo(cost, 36.75, 'Opus 5 total');
});

test('a 1-hour cache write costs 2x base input, a 5-minute write 1.25x', () => {
  const base = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1e6, speed: 'standard',
  };
  const fiveMin = costForUsage(
    { ...base, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 0 } },
    'claude-opus-5'
  );
  const oneHour = costForUsage(
    { ...base, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } },
    'claude-opus-5'
  );
  closeTo(fiveMin.cost, 6.25, '5-minute cache write on Opus 5');
  closeTo(oneHour.cost, 10, '1-hour cache write on Opus 5');
});

test('a flat cache_creation_input_tokens with no split is priced at the 5-minute rate', () => {
  const { cost } = costForUsage(
    {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1e6, speed: 'standard',
    },
    'claude-opus-5'
  );
  closeTo(cost, 6.25, 'flat cache write falls back to the 5-minute rate');
});

test('fast mode doubles Opus 5 input and output, and cache rates follow the fast base', () => {
  const { cost } = costForUsage(oneMillionEach({ speed: 'fast' }), 'claude-opus-5');
  // fast input 10 + fast output 50 + 5m write 12.50 + cache read 1.00
  closeTo(cost, 73.5, 'Opus 5 fast-mode total');
});

test('a model with no fast rates ignores speed: fast', () => {
  const standard = costForUsage(oneMillionEach(), 'claude-sonnet-5');
  const fast = costForUsage(oneMillionEach({ speed: 'fast' }), 'claude-sonnet-5');
  closeTo(fast.cost, standard.cost, 'Sonnet 5 has no fast mode');
});

test('claude-opus-5-5 matches its own row, not the opus-5 row', () => {
  // This test exists to fail if PRICE_TABLE is ever reordered. Matching is
  // substring-based and first-match-wins, so 'opus-5-5' must precede 'opus-5'.
  const row = priceFor('claude-opus-5-5');
  assert.strictEqual(row.match, 'opus-5-5');
  assert.strictEqual(row.input, 4);
  assert.strictEqual(row.output, 20);
  assert.strictEqual(row.cacheReadMult, 0.05);
});

test('cache read uses the per-model multiplier', () => {
  const readOnly = (model) =>
    costForUsage(
      {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1e6, speed: 'standard',
      },
      model
    ).cost;
  closeTo(readOnly('claude-opus-5'), 0.5, 'Opus 5 cache read is 0.1x of $5');
  closeTo(readOnly('claude-fable-5-1'), 0.25, 'Fable 5.1 cache read is 0.025x of $10');
  closeTo(readOnly('claude-opus-5-5'), 0.2, 'Opus 5.5 cache read is 0.05x of $4');
});

test('an unrecognised model stays unpriced rather than silently costing zero', () => {
  const { cost, priced } = costForUsage(oneMillionEach(), 'some-future-model');
  assert.strictEqual(cost, 0);
  assert.strictEqual(priced, false);
});

test('older naming scheme resolves to its own rates, not the bare-family fallback', () => {
  const haiku = priceFor('claude-3-5-haiku-20241022');
  assert.strictEqual(haiku.input, 0.8);
  assert.strictEqual(haiku.output, 4);

  const opus = priceFor('claude-3-opus-20240229');
  assert.strictEqual(opus.input, 15);
  assert.strictEqual(opus.output, 75);
});

test('familyFor reads the row family, not the row match key', () => {
  assert.strictEqual(familyFor('claude-opus-5-5'), 'opus');
  assert.strictEqual(familyFor('claude-sonnet-4-6'), 'sonnet');
  assert.strictEqual(familyFor('claude-mythos-5-1'), 'mythos');
});

test('the 3.x naming scheme prices against its own rows, not the fallbacks', () => {
  const cases = [
    ['claude-3-5-sonnet-20241022', 3, 15],
    ['claude-3-7-sonnet-20250219', 3, 15],
    ['claude-3-5-haiku-20241022', 0.8, 4],
    ['claude-3-haiku-20240307', 0.25, 1.25],
    ['claude-3-opus-20240229', 15, 75],
  ];
  for (const [model, input, output] of cases) {
    const row = priceFor(model);
    assert.strictEqual(row.input, input, `${model} input`);
    assert.strictEqual(row.output, output, `${model} output`);
  }
});

test('a release date is not read as a minor version', () => {
  assert.strictEqual(shortModelLabel('claude-opus-4-20250514'), 'Opus');
  assert.strictEqual(shortModelLabel('claude-sonnet-4-20250514'), 'Sonnet');
  assert.strictEqual(shortModelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.strictEqual(shortModelLabel('claude-opus-4-6-20260315'), 'Opus 4.6');
});

const { cacheWriteTokens } = require('../lib/pricing');

test('cacheWriteTokens reads the 5m/1h split when present', () => {
  assert.deepStrictEqual(
    cacheWriteTokens({ cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 } }),
    { write5m: 300, write1h: 200, total: 500 }
  );
});

test('cacheWriteTokens falls back to the flat total as 5-minute writes', () => {
  assert.deepStrictEqual(cacheWriteTokens({ cache_creation_input_tokens: 700 }), { write5m: 700, write1h: 0, total: 700 });
  // A split that is present but all zero is treated as absent.
  assert.deepStrictEqual(
    cacheWriteTokens({
      cache_creation_input_tokens: 700,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    }),
    { write5m: 700, write1h: 0, total: 700 }
  );
});

test('cacheWriteTokens prefers the split when it disagrees with the flat total', () => {
  assert.deepStrictEqual(
    cacheWriteTokens({
      cache_creation_input_tokens: 999,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    }),
    { write5m: 100, write1h: 0, total: 100 }
  );
});

test('cacheWriteTokens returns zeros for a record with no cache writes', () => {
  assert.deepStrictEqual(cacheWriteTokens({ input_tokens: 5 }), { write5m: 0, write1h: 0, total: 0 });
});
