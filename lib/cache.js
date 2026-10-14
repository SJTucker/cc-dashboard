'use strict';

// Prompt cache figures shared by the Live sessions State cell (cacheOf in
// lib/sessions.js) and the statusline line (bin/cache-line).

const { costForUsage, cacheWriteTokens } = require('./pricing');

const TTL_5M_MS = 5 * 60 * 1000;
const TTL_1H_MS = 60 * 60 * 1000;

// A 1-hour write sets a 1-hour TTL and a 5-minute write a 5-minute one. A call that
// only read the cache leaves the TTL as it was.
function nextTtl(usage, ttl) {
  const { write5m, write1h } = cacheWriteTokens(usage);
  if (write1h > 0) return TTL_1H_MS;
  return write5m > 0 ? TTL_5M_MS : ttl;
}

// The cache_creation field a write at each TTL is counted in.
const WRITE_FIELD = { '5m': 'ephemeral_5m_input_tokens', '1h': 'ephemeral_1h_input_tokens' };

// What the next reply pays to write `tokens` back into the prompt cache at `ttl`
// ('5m' or '1h'), over what reading them would cost. Null for an unpriced model,
// an unknown TTL, or no tokens.
function rebuildUsd(tokens, ttl, model, t) {
  const field = WRITE_FIELD[ttl];
  if (!field || !(tokens > 0)) return null;
  const write = costForUsage({ cache_creation: { [field]: tokens } }, model, t);
  if (!write.priced) return null;
  const read = costForUsage({ cache_read_input_tokens: tokens }, model, t);
  return write.cost - read.cost;
}

// Dollars as the page's formatCost (public/format.mjs) shows them. That file is a
// browser module that lib/ cannot require.
function formatUsd(usd) {
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The statusline's cache line from the JSON Claude Code sends a statusline
// command: how long the prompt cache has left, and what the next reply pays to
// rebuild it. `prompt_cache.expires_at` is in epoch seconds and `now` in ms.
// Null before the session has cached anything, and for input with no
// prompt_cache (Claude Code before 2.1.251).
function cacheStatusLine(input, now) {
  const cache = input && input.prompt_cache;
  if (!cache || !cache.caching_observed) return null;
  const usd = rebuildUsd(cache.recache_tokens_if_cold, cache.ttl, input.model && input.model.id, now);
  const cost = usd == null ? '' : ` · rebuild ${formatUsd(usd)}`;
  const leftMs = typeof cache.expires_at === 'number' ? cache.expires_at * 1000 - now : null;
  if (!cache.warm || (leftMs != null && leftMs <= 0)) return `cache expired${cost}`;
  if (leftMs == null) return null;
  if (leftMs < 60_000) return `cache under 1 min${cost}`;
  return `cache ${Math.floor(leftMs / 60_000)} min left${cost}`;
}

module.exports = { TTL_5M_MS, TTL_1H_MS, nextTtl, rebuildUsd, cacheStatusLine };
