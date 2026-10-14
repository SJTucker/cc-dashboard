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
  assert.strictEqual(shortModelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.strictEqual(shortModelLabel('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.strictEqual(shortModelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.strictEqual(shortModelLabel('claude-opus-4-6-20260315'), 'Opus 4.6');
  assert.strictEqual(shortModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
});

test('a model id with no minor version shows its major version', () => {
  assert.strictEqual(shortModelLabel('claude-opus-5'), 'Opus 5');
  assert.strictEqual(shortModelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.strictEqual(shortModelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.strictEqual(shortModelLabel('claude-opus-5-20260101'), 'Opus 5');
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

const { setSnapshots, currentRows, validateRow, localMidnight } = require('../lib/pricing');

function sonnet46(input, output) {
  return { match: 'sonnet-4-6', family: 'sonnet', label: 'Sonnet', input, output };
}

test('a changed price applies from its effective date, and earlier usage keeps the old price', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [sonnet46(6, 30)] }]);
  const before = new Date(2026, 9, 14, 23, 59).getTime();
  const after = new Date(2026, 9, 15, 9, 0).getTime();
  assert.strictEqual(priceFor('claude-sonnet-4-6', before).input, 3);
  assert.strictEqual(priceFor('claude-sonnet-4-6', after).input, 6);
  assert.strictEqual(priceFor('claude-sonnet-4-6').input, 6, 'no time means current prices');
});

test('the effective date starts at local midnight', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [sonnet46(6, 30)] }]);
  const midnight = new Date(2026, 9, 15).getTime();
  assert.strictEqual(localMidnight('2026-10-15'), midnight);
  assert.strictEqual(priceFor('claude-sonnet-4-6', midnight - 1).input, 3);
  assert.strictEqual(priceFor('claude-sonnet-4-6', midnight).input, 6);
});

test('two snapshots on one row each apply from their own date', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([
    { effectiveFrom: '2026-10-01', rows: [sonnet46(4, 20)] },
    { effectiveFrom: '2026-11-01', rows: [sonnet46(6, 30)] },
  ]);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 8, 30).getTime()).input, 3);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 15).getTime()).input, 4);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 10, 15).getTime()).input, 6);
});

test('a model new to the table is priced at its first known rate for all dates', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [{ match: 'opus-6', family: 'opus', label: 'Opus', input: 7, output: 35 }] }]);
  const row = priceFor('claude-opus-6', new Date(2026, 0, 1).getTime());
  assert.strictEqual(row.match, 'opus-6', 'not the bare opus fallback');
  assert.strictEqual(row.input, 7);
});

test('a match key does not fire inside a longer digit run, so an auto-added key cannot re-price an existing dated id', (t) => {
  t.after(() => setSnapshots([]));
  // 'sonnet-4-2' lands ahead of 'sonnet-4' by the substring-containment rule,
  // and 'claude-sonnet-4-20250514' contains 'sonnet-4-2' as a plain substring
  // (the '2' of '20250514'). Without a digit-boundary check every dated
  // Sonnet 4 id would be re-priced as Sonnet "4.2".
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [{ match: 'sonnet-4-2', family: 'sonnet', label: 'Sonnet', input: 9, output: 45 }] }]);
  assert.strictEqual(priceFor('claude-sonnet-4-20250514').match, 'sonnet-4');
  assert.strictEqual(priceFor('claude-sonnet-4-2').match, 'sonnet-4-2');
});

test('a new row lands ahead of every row whose key it contains', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [{ match: 'opus-5-6', family: 'opus', label: 'Opus', input: 3, output: 15 }] }]);
  assert.strictEqual(priceFor('claude-opus-5-6').match, 'opus-5-6');
  assert.strictEqual(priceFor('claude-opus-5-5').match, 'opus-5-5');
  assert.strictEqual(priceFor('claude-opus-5').match, 'opus-5');
});

test('costForUsage prices a record by its time', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [sonnet46(6, 30)] }]);
  const usage = { input_tokens: 1e6, output_tokens: 0 };
  closeTo(costForUsage(usage, 'claude-sonnet-4-6', new Date(2026, 9, 1).getTime()).cost, 3, 'old price');
  closeTo(costForUsage(usage, 'claude-sonnet-4-6', new Date(2026, 9, 20).getTime()).cost, 6, 'new price');
});

test('currentRows reports the latest price of every row, and setSnapshots([]) restores the built-in table', (t) => {
  t.after(() => setSnapshots([]));
  const builtIn = currentRows();
  setSnapshots([{ effectiveFrom: '2026-10-15', rows: [sonnet46(6, 30), { match: 'opus-6', family: 'opus', label: 'Opus', input: 7, output: 35 }] }]);
  const rows = currentRows();
  assert.strictEqual(rows.length, builtIn.length + 1);
  assert.strictEqual(rows.find((r) => r.match === 'sonnet-4-6').input, 6);
  setSnapshots([]);
  assert.deepStrictEqual(currentRows(), builtIn);
});

test('validateRow refuses rows the cost math cannot use', () => {
  const ok = { match: 'opus-6', family: 'opus', label: 'Opus', input: 5, output: 25 };
  assert.strictEqual(validateRow(ok), null);
  assert.strictEqual(validateRow({ ...ok, cacheReadMult: 0.05, fast: { input: 10, output: 50 } }), null);
  assert.match(validateRow({ ...ok, match: 'opus' }), /match/, 'a bare family key would shadow the fallback');
  assert.match(validateRow({ ...ok, family: 'zephyr' }), /family/);
  assert.match(validateRow({ ...ok, match: 'sonnet-6' }), /match/, 'key must contain its family');
  assert.match(validateRow({ ...ok, input: 0 }), /input/);
  assert.match(validateRow({ ...ok, output: 5 }), /output/);
  assert.match(validateRow({ ...ok, cacheReadMult: 1.5 }), /cacheReadMult/);
  assert.match(validateRow({ ...ok, fast: { input: 10, output: 5 } }), /fast/);
  assert.match(validateRow(null), /object/);
});

const { outputRate } = require('../lib/pricing');

test('outputRate is the output price per token, standard and fast', () => {
  closeTo(outputRate({}, 'claude-opus-5') * 1e6, 25, 'Opus 5 standard output per MTok');
  closeTo(outputRate({ speed: 'fast' }, 'claude-opus-5') * 1e6, 50, 'Opus 5 fast output per MTok');
  closeTo(outputRate({ speed: 'fast' }, 'claude-sonnet-5'), outputRate({}, 'claude-sonnet-5'), 'Sonnet 5 has no fast mode');
});

test('outputRate is null for an unrecognised model', () => {
  assert.strictEqual(outputRate({}, 'some-unknown-model'), null);
});

test('outputRate matches the output term of costForUsage', () => {
  for (const [usage, model] of [[{}, 'claude-opus-5'], [{ speed: 'fast' }, 'claude-opus-5'], [{}, 'claude-haiku-4-5-20251001']]) {
    const { cost } = costForUsage({ ...usage, output_tokens: 1_000_000 }, model);
    closeTo(outputRate(usage, model) * 1_000_000, cost, `${model} ${usage.speed || 'standard'}`);
  }
});

// ---- longPrompt tier -------------------------------------------------------
// A snapshot row for a model the table has not seen is priced for all dates, so
// these tests install Haiku 5.5 that way. Task 3 adds the built-in row.
const HAIKU_55 = {
  match: 'haiku-5-5', family: 'haiku', label: 'Haiku', input: 0.10, output: 0.50,
  longPrompt: { over: 100000, input: 0.50, output: 2.50 },
};

function useHaiku55(t) {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-01', rows: [HAIKU_55] }]);
}

test('a Haiku 5.5 request uses the lower rates at 100,000 prompt tokens and the higher at 100,001', (t) => {
  useHaiku55(t);
  closeTo(costForUsage({ input_tokens: 100000, output_tokens: 1000 }, 'claude-haiku-5-5').cost, (100000 * 0.10 + 1000 * 0.50) / 1e6, 'at the threshold');
  closeTo(costForUsage({ input_tokens: 100001, output_tokens: 1000 }, 'claude-haiku-5-5').cost, (100001 * 0.50 + 1000 * 2.50) / 1e6, 'one over');
});

test('prompt size counts cache reads and cache writes of both lifetimes, and not output tokens', (t) => {
  useHaiku55(t);
  const split = (reads, w5m, w1h) => ({ input_tokens: 0, cache_read_input_tokens: reads, cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h } });
  // 60,000 + 30,000 + 10,001 = 100,001: long rates, with the 0.1x read and 1.25x / 2x write multipliers on 0.50.
  closeTo(costForUsage(split(60000, 30000, 10001), 'claude-haiku-5-5').cost, (60000 * 0.50 * 0.1 + 30000 * 0.50 * 1.25 + 10001 * 0.50 * 2) / 1e6, 'over by one');
  // 60,000 + 30,000 + 10,000 = 100,000: lower rates.
  closeTo(costForUsage(split(60000, 30000, 10000), 'claude-haiku-5-5').cost, (60000 * 0.10 * 0.1 + 30000 * 0.10 * 1.25 + 10000 * 0.10 * 2) / 1e6, 'at the threshold');
  // A flat cache_creation_input_tokens total counts as 5-minute writes.
  closeTo(costForUsage({ cache_creation_input_tokens: 100001 }, 'claude-haiku-5-5').cost, (100001 * 0.50 * 1.25) / 1e6, 'flat write total over the threshold');
  // 500,000 output tokens do not make a 100,000-token prompt long.
  closeTo(costForUsage({ input_tokens: 100000, output_tokens: 500000 }, 'claude-haiku-5-5').cost, (100000 * 0.10 + 500000 * 0.50) / 1e6, 'output is not prompt');
});

test('a usage record with missing or null fields costs zero on a tiered row, not NaN', (t) => {
  useHaiku55(t);
  assert.strictEqual(costForUsage({}, 'claude-haiku-5-5').cost, 0);
  assert.strictEqual(costForUsage({ input_tokens: null, cache_read_input_tokens: undefined, cache_creation: null }, 'claude-haiku-5-5').cost, 0);
});

test('outputRate follows the prompt-length tier', (t) => {
  useHaiku55(t);
  closeTo(outputRate({ input_tokens: 100000 }, 'claude-haiku-5-5') * 1e6, 0.5, 'lower output per MTok');
  closeTo(outputRate({ input_tokens: 100001 }, 'claude-haiku-5-5') * 1e6, 2.5, 'higher output per MTok');
});

test('fast rates win over the prompt-length tier on a row with both', (t) => {
  t.after(() => setSnapshots([]));
  setSnapshots([{ effectiveFrom: '2026-10-01', rows: [{ ...HAIKU_55, match: 'haiku-5-6', fast: { input: 1, output: 5 }, longPrompt: { over: 1000, input: 0.5, output: 2.5 } }] }]);
  closeTo(outputRate({ input_tokens: 5000, speed: 'fast' }, 'claude-haiku-5-6') * 1e6, 5, 'fast request over the threshold');
  closeTo(outputRate({ input_tokens: 5000 }, 'claude-haiku-5-6') * 1e6, 2.5, 'standard request over the threshold');
});

test('currentRows carries longPrompt', (t) => {
  useHaiku55(t);
  assert.deepStrictEqual(currentRows().find((r) => r.match === 'haiku-5-5').longPrompt, { over: 100000, input: 0.50, output: 2.50 });
});

test('validateRow accepts a sound longPrompt and refuses a malformed one', () => {
  assert.strictEqual(validateRow(HAIKU_55), null);
  for (const bad of [
    { over: 0, input: 0.5, output: 2.5 },
    { over: 1.5, input: 0.5, output: 2.5 },
    { over: '100000', input: 0.5, output: 2.5 },
    { over: 100000, input: 0, output: 2.5 },
    { over: 100000, input: 0.5, output: -1 },
    { over: 100000, input: 0.5 },
    'long',
  ]) {
    assert.match(validateRow({ ...HAIKU_55, longPrompt: bad }), /longPrompt/, JSON.stringify(bad));
  }
});

// ---- unmatched models and family rates -------------------------------------
const { unmatchedModels, clearUnmatched } = require('../lib/pricing');

test('priceFor records a name that matches nothing or only a bare-family row, and not a versioned match', () => {
  clearUnmatched();
  priceFor('claude-sonnet-4-6-20260115');
  priceFor('claude-opus-5');
  priceFor('claude-opus-5-5');
  assert.deepStrictEqual(unmatchedModels(), []);
  priceFor('claude-zeta-9');
  priceFor('claude-opus-9');
  priceFor('claude-haiku-9');
  assert.deepStrictEqual(unmatchedModels(), ['claude-haiku-9', 'claude-opus-9', 'claude-zeta-9']);
  clearUnmatched();
  assert.deepStrictEqual(unmatchedModels(), []);
});

test('synthetic, empty and non-Anthropic model names are never recorded as unmatched', () => {
  clearUnmatched();
  priceFor('<synthetic>');
  priceFor('');
  priceFor(null);
  priceFor(undefined);
  costForUsage({ input_tokens: 10 }, '<synthetic>');
  costForUsage({ input_tokens: 10 }, 'gpt-4o');
  assert.deepStrictEqual(unmatchedModels(), []);
});

test('costForUsage reports familyRate for a bare-family match only', () => {
  assert.strictEqual(costForUsage({ input_tokens: 1000 }, 'claude-opus-9').familyRate, true);
  assert.strictEqual(costForUsage({ input_tokens: 1000 }, 'claude-opus-5').familyRate, false);
  const unpriced = costForUsage({ input_tokens: 1000 }, 'claude-zeta-9');
  assert.deepStrictEqual([unpriced.cost, unpriced.priced, unpriced.familyRate], [0, false, undefined]);
  assert.deepStrictEqual(unpriced.parts, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, saved: 0, priced: false });
});

test('the built-in table has Haiku 5.5 with its tier and Sonnet 5.5 at 0.05x cache reads', () => {
  assert.deepStrictEqual(priceFor('claude-haiku-5-5').longPrompt, { over: 100000, input: 0.5, output: 2.5 });
  assert.strictEqual(priceFor('claude-haiku-5-5').input, 0.1);
  assert.strictEqual(priceFor('claude-haiku-4-5-20251001').longPrompt, undefined);
  assert.strictEqual(priceFor('claude-sonnet-5-5').cacheReadMult, 0.05);
  assert.strictEqual(priceFor('claude-sonnet-5').cacheReadMult, undefined, 'sonnet-5 keeps its own row');
  // A sample Haiku 5.5 request: 1,000 input and 200 output tokens is a short prompt.
  closeTo(costForUsage({ input_tokens: 1000, output_tokens: 200 }, 'claude-haiku-5-5').cost, (1000 * 0.10 + 200 * 0.50) / 1e6, 'short Haiku 5.5 request');
});

// ---- costParts -------------------------------------------------------------
const { costParts } = require('../lib/pricing');

function assertPartsSum(usage, model, expectedCost, message) {
  const p = costParts(usage, model);
  const whole = costForUsage(usage, model).cost;
  closeTo(p.input + p.output + p.cacheWrite + p.cacheRead, whole, `${message}: parts sum to costForUsage`);
  closeTo(whole, expectedCost, `${message}: total`);
  return p;
}

test('costParts splits a base-rate call and saved is reads at input rate minus read rate', () => {
  const p = assertPartsSum(oneMillionEach(), 'claude-opus-5', 36.75, 'Opus 5');
  closeTo(p.input, 5, 'input');
  closeTo(p.output, 25, 'output');
  closeTo(p.cacheWrite, 6.25, 'cache write');
  closeTo(p.cacheRead, 0.5, 'cache read');
  closeTo(p.saved, 4.5, 'saved = 5 - 0.5');
  assert.strictEqual(p.priced, true);
});

test('costParts uses fast rates in fast mode', () => {
  const p = assertPartsSum(oneMillionEach({ speed: 'fast' }), 'claude-opus-5', 73.5, 'Opus 5 fast');
  closeTo(p.input, 10, 'fast input');
  closeTo(p.saved, 9, 'saved at fast input rate');
});

test('costParts uses the Haiku 5.5 long-prompt rates over 100k and adds 5m and 1h writes into cacheWrite', (t) => {
  useHaiku55(t);
  const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 60000, cache_creation: { ephemeral_5m_input_tokens: 30000, ephemeral_1h_input_tokens: 10000 } };
  const p = assertPartsSum(usage, 'claude-haiku-5-5', (1000 * 0.5 + 2000 * 2.5 + 30000 * 0.5 * 1.25 + 10000 * 0.5 * 2 + 60000 * 0.5 * 0.1) / 1e6, 'Haiku long');
  closeTo(p.cacheWrite, (30000 * 0.5 * 1.25 + 10000 * 0.5 * 2) / 1e6, 'both write lifetimes');
  closeTo(p.saved, (60000 * 0.5 * 0.9) / 1e6, 'saved at long input rate');
});

test('costParts prices a 1-hour write at 2x input', () => {
  const p = costParts({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } }, 'claude-opus-5');
  closeTo(p.cacheWrite, 10, '1h write');
  closeTo(p.saved, 0, 'no reads, nothing saved');
});

test('costParts honours a row cacheReadMult', () => {
  const usage = oneMillionEach();
  const p = assertPartsSum(usage, 'claude-opus-5-5', 4 + 20 + 5 + 0.2, 'Opus 5.5');
  closeTo(p.cacheRead, 0.2, 'read at 0.05x of 4');
  closeTo(p.saved, 3.8, 'saved = 4 - 0.2');
});

test('costParts gives zeros and priced false for an unrecognised model', () => {
  const p = costParts(oneMillionEach(), 'mystery-model');
  assert.deepStrictEqual(p, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, saved: 0, priced: false });
});
