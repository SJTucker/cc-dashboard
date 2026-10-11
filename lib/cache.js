'use strict';

// Prompt cache figures shared by the Running now table (cacheOf in
// lib/sessions.js) and the statusline line (bin/cache-line).

const { costForUsage } = require('./pricing');

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

module.exports = { rebuildUsd };
