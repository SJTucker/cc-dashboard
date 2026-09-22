'use strict';

// Prices are USD per MILLION tokens, copied from Anthropic's published pricing
// page. costForUsage divides by 1e6 at the end, so these read exactly like the
// docs table and a price change is a one-number edit.
//
// Cache prices are not listed. Anthropic defines them as multipliers on base
// input price, and every published cache price is reproduced exactly by these
// two constants plus the per-row cacheReadMult:
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const DEFAULT_CACHE_READ_MULT = 0.1;
//
// Long-context tiering is deliberately absent. Claude 4.6 and later bill the
// full 1M context window at standard rates - a 900K-token request costs the
// same per token as a 9K one - so a >200K tier would introduce an error.
//
// Matching is substring-based against the model name Claude Code logs (e.g.
// "claude-opus-5"), FIRST MATCH WINS. Row order is therefore load-bearing:
// 'opus-5-5' must precede 'opus-5', and bare 'opus-4' must follow every
// 'opus-4-N' row. test/pricing.test.js has a test whose only job is to fail if
// this order is disturbed.
//
// The five bare-family rows at the bottom catch a model released after this
// table was written. They carry current-generation rates on purpose: pricing an
// unknown future Opus like Opus 5 is a far smaller error than pricing it like
// Opus 4.1, which is the bug this table replaced.
const PRICE_TABLE = [
  { match: 'fable-5-1', family: 'fable', label: 'Fable', input: 10, output: 50, cacheReadMult: 0.025 },
  { match: 'mythos-5-1', family: 'mythos', label: 'Mythos', input: 10, output: 50, cacheReadMult: 0.025 },
  { match: 'fable-5', family: 'fable', label: 'Fable', input: 10, output: 50 },
  { match: 'mythos-5', family: 'mythos', label: 'Mythos', input: 10, output: 50 },

  { match: 'opus-5-5', family: 'opus', label: 'Opus', input: 4, output: 20, cacheReadMult: 0.05, fast: { input: 8, output: 40 } },
  { match: 'opus-5', family: 'opus', label: 'Opus', input: 5, output: 25, fast: { input: 10, output: 50 } },
  { match: 'opus-4-8', family: 'opus', label: 'Opus', input: 5, output: 25, fast: { input: 10, output: 50 } },
  { match: 'opus-4-7', family: 'opus', label: 'Opus', input: 5, output: 25 },
  { match: 'opus-4-6', family: 'opus', label: 'Opus', input: 5, output: 25 },
  { match: 'opus-4-5', family: 'opus', label: 'Opus', input: 5, output: 25 },
  { match: 'opus-4-1', family: 'opus', label: 'Opus', input: 15, output: 75 },
  { match: 'opus-4', family: 'opus', label: 'Opus', input: 15, output: 75 },

  { match: 'sonnet-5', family: 'sonnet', label: 'Sonnet', input: 2, output: 10 },
  { match: 'sonnet-4-6', family: 'sonnet', label: 'Sonnet', input: 3, output: 15 },
  { match: 'sonnet-4-5', family: 'sonnet', label: 'Sonnet', input: 3, output: 15 },
  { match: 'sonnet-4', family: 'sonnet', label: 'Sonnet', input: 3, output: 15 },

  { match: 'haiku-4-5', family: 'haiku', label: 'Haiku', input: 1, output: 5 },

  // Older naming scheme: Anthropic writes the 3.x line as claude-3-5-sonnet-*,
  // claude-3-opus-* and so on, with the version BEFORE the family name. None of
  // the version-first rows above can match those, so without these rows they
  // fall through to the bare-family fallbacks and price wrong in both
  // directions - Opus 3 at $5/$25 instead of $15/$75, Haiku 3 at $1/$5 instead
  // of $0.25/$1.25. Keep 3-5-haiku ahead of 3-haiku: '3-haiku' is not a
  // substring of '3-5-haiku', but the pairing is easy to break by editing.
  { match: '3-5-haiku', family: 'haiku', label: 'Haiku', input: 0.8, output: 4 },
  { match: '3-haiku', family: 'haiku', label: 'Haiku', input: 0.25, output: 1.25 },
  { match: '3-5-sonnet', family: 'sonnet', label: 'Sonnet', input: 3, output: 15 },
  { match: '3-7-sonnet', family: 'sonnet', label: 'Sonnet', input: 3, output: 15 },
  { match: '3-opus', family: 'opus', label: 'Opus', input: 15, output: 75 },

  // Fallbacks for model names this table has not seen. Current-generation rates.
  { match: 'opus', family: 'opus', label: 'Opus', input: 5, output: 25 },
  { match: 'sonnet', family: 'sonnet', label: 'Sonnet', input: 2, output: 10 },
  { match: 'haiku', family: 'haiku', label: 'Haiku', input: 1, output: 5 },
  { match: 'fable', family: 'fable', label: 'Fable', input: 10, output: 50 },
  { match: 'mythos', family: 'mythos', label: 'Mythos', input: 10, output: 50 },
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

  // Fast mode is a research preview on the Opus line only. A row with no fast
  // rates ignores speed entirely.
  const rates = usage.speed === 'fast' && row.fast ? row.fast : row;
  const readMult = row.cacheReadMult != null ? row.cacheReadMult : DEFAULT_CACHE_READ_MULT;

  // 5-minute and 1-hour cache writes differ by 1.6x, so the split matters.
  // Older entries carry only the flat total; charge those the lower rate
  // rather than guess high.
  const split = usage.cache_creation || {};
  let write5m = split.ephemeral_5m_input_tokens || 0;
  const write1h = split.ephemeral_1h_input_tokens || 0;
  if (write5m === 0 && write1h === 0) write5m = usage.cache_creation_input_tokens || 0;

  const perMillion =
    (usage.input_tokens || 0) * rates.input +
    (usage.output_tokens || 0) * rates.output +
    write5m * rates.input * CACHE_WRITE_5M_MULT +
    write1h * rates.input * CACHE_WRITE_1H_MULT +
    (usage.cache_read_input_tokens || 0) * rates.input * readMult;

  return { cost: perMillion / 1e6, priced: true };
}

/** Short display label for a model name, e.g. "claude-opus-4-6-20260315" -> "Opus 4.6". */
function shortModelLabel(modelName) {
  if (!modelName) return 'unknown';
  const row = priceFor(modelName);
  // The minor version is capped at two digits so a release date cannot be read
  // as one: 'claude-opus-4-20250514' is Opus 4, not Opus 4.20250514. A real
  // minor is always one or two digits and is never followed by another digit.
  const versionMatch = modelName.match(/(\d+)[.-](\d{1,2})(?!\d)/);
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : '';
  return row ? `${row.label}${version ? ' ' + version : ''}` : modelName;
}

// The UI colours each model by family, and MODEL_STYLE in public/app.js keys on
// exactly these six values. Rows carry family separately from match because
// match is now version-specific ('opus-5-5') while the family is not.
function familyFor(model) {
  const row = priceFor(model);
  return row ? row.family : 'other';
}

module.exports = { priceFor, costForUsage, shortModelLabel, familyFor };
