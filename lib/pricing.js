'use strict';

// All prices are USD per token (i.e. sticker price per million tokens, divided by 1e6).
// These are approximate list prices and WILL drift out of date - Anthropic changes pricing
// from time to time. Check https://claude.com/pricing and edit the numbers below if you want
// accurate cost figures. This dashboard deliberately does NOT fetch pricing from the network:
// it trades "always up to date" for "never makes an outbound request."
//
// Matching is by substring against the model name Claude Code logs (e.g.
// "claude-sonnet-4-6-20260115"), checked in the order listed below, so put more specific
// names first if you add your own.
const PRICE_TABLE = [
  {
    match: 'opus',
    label: 'Opus',
    input: 15 / 1e6,
    output: 75 / 1e6,
    cacheWrite: 18.75 / 1e6,
    cacheRead: 1.5 / 1e6,
  },
  {
    match: 'sonnet',
    label: 'Sonnet',
    input: 3 / 1e6,
    output: 15 / 1e6,
    cacheWrite: 3.75 / 1e6,
    cacheRead: 0.3 / 1e6,
  },
  {
    match: 'haiku',
    label: 'Haiku',
    input: 1 / 1e6,
    output: 5 / 1e6,
    cacheWrite: 1.25 / 1e6,
    cacheRead: 0.1 / 1e6,
  },
  {
    match: 'fable',
    label: 'Fable',
    input: 10 / 1e6,
    output: 50 / 1e6,
    cacheWrite: 12.5 / 1e6,
    cacheRead: 1 / 1e6,
  },
  {
    match: 'mythos',
    label: 'Mythos',
    input: 10 / 1e6,
    output: 50 / 1e6,
    cacheWrite: 12.5 / 1e6,
    cacheRead: 1 / 1e6,
  },
];

/**
 * Look up a price row for a model name. Returns null for anything unrecognized
 * (synthetic/internal model tags, future model names, etc) rather than guessing.
 */
function priceFor(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  for (const row of PRICE_TABLE) {
    if (lower.includes(row.match)) return row;
  }
  return null;
}

/**
 * Cost in USD for one usage record, given a model name.
 * Returns { cost, priced } - priced is false when the model wasn't recognized,
 * so the caller can show "unpriced" instead of a silently-wrong $0.00.
 */
function costForUsage(usage, modelName) {
  const row = priceFor(modelName);
  if (!row) return { cost: 0, priced: false };
  const cost =
    (usage.input_tokens || 0) * row.input +
    (usage.output_tokens || 0) * row.output +
    (usage.cache_creation_input_tokens || 0) * row.cacheWrite +
    (usage.cache_read_input_tokens || 0) * row.cacheRead;
  return { cost, priced: true };
}

/** Short display label for a model name, e.g. "claude-opus-4-6-20260315" -> "Opus 4.6". */
function shortModelLabel(modelName) {
  if (!modelName) return 'unknown';
  const row = priceFor(modelName);
  const versionMatch = modelName.match(/(\d+)[.-](\d+)/);
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : '';
  return row ? `${row.label}${version ? ' ' + version : ''}` : modelName;
}

// The UI colours each model by family, and the families are exactly the PRICE_TABLE
// match strings. Deriving them here keeps one list: adding a model to the table
// gives it a family without touching the front end.
function familyFor(model) {
  if (!model) return 'other';
  const name = String(model).toLowerCase();
  const entry = PRICE_TABLE.find((row) => name.includes(row.match));
  return entry ? entry.match : 'other';
}

module.exports = { priceFor, costForUsage, shortModelLabel, familyFor };
