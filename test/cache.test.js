'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rebuildUsd } = require('../lib/cache');

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
