'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/price-lines.mjs');

const SONNET = { match: 'sonnet-5-5', name: 'Claude Sonnet 5.5', input: 2, output: 10 };
const HAIKU = { match: 'haiku-5-5', name: 'Claude Haiku 5.5', input: 0.1, output: 0.5, longPrompt: { over: 100000, input: 0.5, output: 2.5 } };

test('checkLines lists an added model for all dates and a changed model from the effective date', async () => {
  const { checkLines } = await load();
  const lines = checkLines({
    added: [HAIKU],
    changed: [{ before: SONNET, after: { ...SONNET, cacheReadMult: 0.05 } }],
    unchanged: 18, skipped: [], effectiveFrom: '2026-10-08',
  });
  assert.deepStrictEqual(lines, ['Added Haiku 5.5, all dates', 'Sonnet 5.5: cache read 0.1x → 0.05x, from 2026-10-08']);
});

test('checkLines says No changes first when nothing changed, and still lists skipped models', async () => {
  const { checkLines } = await load();
  assert.deepStrictEqual(checkLines({ added: [], changed: [], unchanged: 20, skipped: [], effectiveFrom: null }), ['No changes']);
  assert.deepStrictEqual(
    checkLines({ added: [], changed: [], unchanged: 20, skipped: [{ name: 'Claude Mythos Preview', reason: 'unrecognised model name' }], effectiveFrom: null }),
    ['No changes', 'Skipped: Claude Mythos Preview (unrecognised model name)'],
  );
});

test('rateChanges names every field that differs', async () => {
  const { rateChanges } = await load();
  const after = { ...SONNET, input: 3, output: 12, cacheReadMult: 0.05, fast: { input: 6, output: 24 }, longPrompt: { over: 200000, input: 6, output: 24 } };
  assert.strictEqual(
    rateChanges(SONNET, after),
    'input $2 → $3, output $10 → $12, cache read 0.1x → 0.05x, fast none → $6 / $24, long prompt none → over 200,000 tokens $6 / $24',
  );
  assert.strictEqual(rateChanges(HAIKU, { ...HAIKU, longPrompt: { ...HAIKU.longPrompt, output: 3 } }),
    'long prompt over 100,000 tokens $0.5 / $2.5 → over 100,000 tokens $0.5 / $3');
});

test('sourceLine shows the effective date and the last check', async () => {
  const { sourceLine } = await load();
  assert.strictEqual(
    sourceLine({ kind: 'fetched', date: '2026-10-08', lastCheck: '2026-10-14', error: null, lastError: null }),
    "Prices: from Anthropic's pricing page, effective 2026-10-08, checked 2026-10-14",
  );
  assert.strictEqual(
    sourceLine({ kind: 'fetched', date: '2026-10-08', lastCheck: null, error: null, lastError: null }),
    "Prices: from Anthropic's pricing page, effective 2026-10-08",
  );
  assert.strictEqual(
    sourceLine({ kind: 'built-in', date: '2026-10-14', lastCheck: null, error: null, lastError: null }),
    'Prices: built-in, checked 2026-10-14',
  );
  assert.strictEqual(
    sourceLine({ kind: 'built-in', date: '2026-10-14', lastCheck: '2026-10-15', error: null, lastError: null }),
    'Prices: built-in, checked 2026-10-15',
  );
});

test('sourceLine adds a failed check and an ignored prices.json', async () => {
  const { sourceLine } = await load();
  assert.strictEqual(
    sourceLine({ kind: 'built-in', date: '2026-10-14', lastCheck: null, error: 'not valid JSON', lastError: 'Could not fetch the page: 503' }),
    'Prices: built-in, checked 2026-10-14 · last check failed: Could not fetch the page: 503 · prices.json ignored: not valid JSON',
  );
});
test('checkLines names a fast rate that is added to or removed from a model, and nothing else', async () => {
  const { checkLines } = await load();
  const OPUS = { match: 'opus-5-5', name: 'Claude Opus 5.5', input: 4, output: 20, cacheReadMult: 0.05 };
  const withFast = { ...OPUS, fast: { input: 8, output: 40 } };
  const lines = (before, after) => checkLines({ added: [], changed: [{ before, after }], unchanged: 19, skipped: [], effectiveFrom: '2026-10-14' });
  assert.deepStrictEqual(lines(OPUS, withFast), ['Opus 5.5: fast none → $8 / $40, from 2026-10-14']);
  assert.deepStrictEqual(lines(withFast, OPUS), ['Opus 5.5: fast $8 / $40 → none, from 2026-10-14']);
});

test('sourceLine says the last good prices are kept when prices.json became unreadable after a good read', async () => {
  const { sourceLine } = await load();
  assert.strictEqual(
    sourceLine({ kind: 'fetched', date: '2026-10-08', snapshots: 2, lastCheck: '2026-10-14', error: 'not valid JSON', lastError: null }),
    "Prices: from Anthropic's pricing page, effective 2026-10-08, checked 2026-10-14 · prices.json unreadable, last good prices kept: not valid JSON",
  );
  assert.strictEqual(
    sourceLine({ kind: 'built-in', date: '2026-10-14', snapshots: 0, lastCheck: null, error: 'not valid JSON', lastError: null }),
    'Prices: built-in, checked 2026-10-14 · prices.json ignored: not valid JSON',
  );
});
