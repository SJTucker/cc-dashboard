'use strict';

// Prompt cache figures shared by the Live sessions State cell (cacheOf in
// lib/sessions.js) and the statusline line (bin/cache-line).

const fs = require('fs');
const path = require('path');
const { costForUsage, cacheWriteTokens } = require('./pricing');
const { writeFileAtomic, prune } = require('./files');
const { SESSION_ID_PATTERN } = require('./session-id');

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

// Claude Code renews the main thread's prompt cache while a turn or a subagent runs,
// about every 30 s, and writes no transcript line for it. Each renewal moves
// prompt_cache.expires_at in the statusline JSON, so bin/cache-line saves that
// expiry for cacheOf (lib/sessions.js) and bin/cache-state, which otherwise count
// from the transcript. One <session id>.json per session.
function getCacheDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'cache');
}

const isTtl = (ttl) => ttl === '5m' || ttl === '1h';

// The saved { ttl, expiresAt, at } for a session, or null when there is none or
// it is malformed. expiresAt and at are in ms. at is when bin/cache-line first saw
// this expiry.
function readCacheState(dir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (!saved || !isTtl(saved.ttl) || !Number.isFinite(saved.expiresAt) || !Number.isFinite(saved.at)) return null;
  return { ttl: saved.ttl, expiresAt: saved.expiresAt, at: saved.at };
}

// Saves the expiry from a statusline JSON. Writes only a warm cache with a known
// expiry, and only when the TTL or the expiry differs from the saved one, so at
// keeps the time this expiry was first seen. A cold cache leaves the file as it
// is, and cacheOf then counts from the transcript. Returns true when it wrote.
// Never throws.
function recordCacheState(input, dir, now) {
  try {
    const id = input?.session_id;
    const cache = input?.prompt_cache;
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return false;
    if (!cache || cache.caching_observed !== true || cache.warm !== true) return false;
    if (typeof cache.expires_at !== 'number' || !isTtl(cache.ttl)) return false;
    const expiresAt = cache.expires_at * 1000;
    const saved = readCacheState(dir, id);
    if (saved && saved.ttl === cache.ttl && saved.expiresAt === expiresAt) return false;
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify({ ttl: cache.ttl, expiresAt, at: now }));
    prune(dir, now);
    return true;
  } catch {
    return false;
  }
}

module.exports = { TTL_5M_MS, TTL_1H_MS, nextTtl, rebuildUsd, cacheStatusLine, getCacheDir, readCacheState, recordCacheState };
