'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rebuildUsd, cacheStatusLine } = require('../lib/cache');

const NOW = Date.parse('2026-10-11T12:00:00Z');
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Opus 5.5 input is $4 per million tokens: a 5m write is 1.25x, a 1h write 2x and
// a read 0.05x. 100k tokens: 5m 0.5 - 0.02 = 0.48, 1h 0.8 - 0.02 = 0.78.
test('rebuildUsd is the write cost at the TTL minus the read cost', () => {
  assert.strictEqual(round6(rebuildUsd(100_000, '5m', 'claude-opus-5-5', NOW)), 0.48);
  assert.strictEqual(round6(rebuildUsd(100_000, '1h', 'claude-opus-5-5', NOW)), 0.78);
});

test('rebuildUsd is null for an unpriced or missing model', () => {
  assert.strictEqual(rebuildUsd(100_000, '5m', 'claude-unknown-9', NOW), null);
  assert.strictEqual(rebuildUsd(100_000, '5m', null, NOW), null);
  assert.strictEqual(rebuildUsd(100_000, '5m', undefined, NOW), null);
});

test('rebuildUsd is null with no tokens or an unknown TTL', () => {
  assert.strictEqual(rebuildUsd(0, '5m', 'claude-opus-5-5', NOW), null);
  assert.strictEqual(rebuildUsd(undefined, '5m', 'claude-opus-5-5', NOW), null);
  assert.strictEqual(rebuildUsd(-5, '1h', 'claude-opus-5-5', NOW), null);
  assert.strictEqual(rebuildUsd(100_000, '10m', 'claude-opus-5-5', NOW), null);
  assert.strictEqual(rebuildUsd(100_000, undefined, 'claude-opus-5-5', NOW), null);
});

// A statusline input as Claude Code 2.1.296 sends it, trimmed to what
// cacheStatusLine reads. expires_at is in epoch seconds.
function statusInput(cache, model = { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }) {
  return { model, prompt_cache: cache };
}
const warm = (msLeft, extra = {}) => ({
  warm: true,
  caching_observed: true,
  ttl: '5m',
  expires_at: (NOW + msLeft) / 1000,
  recache_tokens_if_cold: 100_000,
  ...extra,
});

test('cacheStatusLine counts whole minutes left, rounded down', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(4 * 60_000 + 59_000)), NOW), 'cache 4 min left · rebuild $0.48');
  assert.strictEqual(cacheStatusLine(statusInput(warm(60_000)), NOW), 'cache 1 min left · rebuild $0.48');
});

test('cacheStatusLine says under 1 min below 60 seconds', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(59_000)), NOW), 'cache under 1 min · rebuild $0.48');
});

test('cacheStatusLine prices a 1h cache at the 1h write rate', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(30 * 60_000, { ttl: '1h' })), NOW), 'cache 30 min left · rebuild $0.78');
});

test('cacheStatusLine says expired when the cache is cold', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(-60_000, { warm: false })), NOW), 'cache expired · rebuild $0.48');
});

test('cacheStatusLine says expired when a warm cache is past expires_at', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(-1_000)), NOW), 'cache expired · rebuild $0.48');
  assert.strictEqual(cacheStatusLine(statusInput(warm(0)), NOW), 'cache expired · rebuild $0.48');
});

test('cacheStatusLine leaves the cost out when it cannot price the rebuild', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000, { recache_tokens_if_cold: 0 })), NOW), 'cache 2 min left');
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000, { recache_tokens_if_cold: undefined })), NOW), 'cache 2 min left');
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000, { ttl: 'weird' })), NOW), 'cache 2 min left');
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000), { id: 'claude-unknown-9' }), NOW), 'cache 2 min left');
  // No model at all. statusInput(cache, undefined) would fall back to its default
  // model, so build the input by hand.
  assert.strictEqual(cacheStatusLine({ prompt_cache: warm(120_000) }, NOW), 'cache 2 min left');
});

test('cacheStatusLine shows <$0.01 for a rebuild under a cent', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000, { recache_tokens_if_cold: 1_000 })), NOW), 'cache 2 min left · rebuild <$0.01');
});

test('cacheStatusLine is null before any caching and without prompt_cache', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000, { caching_observed: false })), NOW), null);
  assert.strictEqual(cacheStatusLine(statusInput(undefined), NOW), null);
  assert.strictEqual(cacheStatusLine({}, NOW), null);
  assert.strictEqual(cacheStatusLine(null, NOW), null);
});

test('cacheStatusLine is null for a warm cache with no expires_at', () => {
  assert.strictEqual(cacheStatusLine(statusInput(warm(120_000, { expires_at: undefined })), NOW), null);
});
