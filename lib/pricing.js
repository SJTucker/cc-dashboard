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

// The date PRICE_TABLE was last checked against Anthropic's pricing page.
const BUILT_IN_DATE = '2026-09-28';

// MODEL_STYLE in public/charts/palette.mjs has a chart texture for each of
// these families.
const KNOWN_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

// Only Haiku 5.5 has a prompt-length tier (`longPrompt` on its row): a request whose
// prompt is over 100,000 tokens pays higher rates. Claude 4.6 and later models
// other than Haiku 5.5 bill the full 1M context window at standard rates - a
// 900K-token request costs the same per token as a 9K one - so a >200K tier would
// introduce an error for them.
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

// The price fields of a row, without its key or display fields.
function ratesOf(row) {
  const rates = { input: row.input, output: row.output };
  if (row.cacheReadMult != null) rates.cacheReadMult = row.cacheReadMult;
  if (row.fast) rates.fast = { input: row.fast.input, output: row.fast.output };
  if (row.longPrompt) rates.longPrompt = { over: row.longPrompt.over, input: row.longPrompt.input, output: row.longPrompt.output };
  return rates;
}

/** Epoch ms of local midnight at the start of a YYYY-MM-DD date. */
function localMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// A new row goes before the first row whose key is a substring of its own. So
// 'opus-5-6' lands ahead of 'opus-5', and 'opus-6' ahead of the bare 'opus'
// fallback. That keeps the first-match-wins order described above PRICE_TABLE.
function insertRow(rows, row) {
  const at = rows.findIndex((r) => row.match.includes(r.match));
  if (at === -1) rows.push(row);
  else rows.splice(at, 0, row);
}

// Each row keeps a list of dated versions. A built-in row's first version starts
// at -Infinity. A snapshot adds a version to an existing row from local midnight of
// its effectiveFrom. A row the table has never seen gets its first price for all
// dates, because the dashboard learned the price late but the model always had it.
function buildTable(snapshots) {
  const rows = PRICE_TABLE.map((row) => ({
    match: row.match,
    family: row.family,
    label: row.label,
    versions: [{ from: -Infinity, ...ratesOf(row) }],
  }));
  for (const snap of snapshots) {
    const from = localMidnight(snap.effectiveFrom);
    for (const row of snap.rows) {
      const existing = rows.find((r) => r.match === row.match);
      if (existing) existing.versions.push({ from, ...ratesOf(row) });
      else insertRow(rows, { match: row.match, family: row.family, label: row.label, versions: [{ from: -Infinity, ...ratesOf(row) }] });
    }
  }
  return rows;
}

let table = buildTable([]);

/** Replace the applied snapshots. Snapshots must be in effectiveFrom order. */
function setSnapshots(snapshots) {
  table = buildTable(snapshots);
}

function flatten(row, version) {
  const { from, ...rates } = version;
  return { match: row.match, family: row.family, label: row.label, ...rates };
}

/** The latest version of every row, in table order. */
function currentRows() {
  return table.map((row) => flatten(row, row.versions[row.versions.length - 1]));
}

// A key matches only where it is not immediately followed by a digit. Checked
// with indexOf over every occurrence, not a RegExp built from the key, because
// the key can appear more than once and can itself contain regex metacharacters.
// Without this, an auto-added key like 'sonnet-4-2' (from a future page row
// "Claude Sonnet 4.2") is a substring of the dated id 'claude-sonnet-4-20250514'
// - the '2' of its release date - and would re-price all of Sonnet 4's history.
function keyMatches(lower, key) {
  let at = lower.indexOf(key);
  while (at !== -1) {
    const after = lower[at + key.length];
    if (after === undefined || after < '0' || after > '9') return true;
    at = lower.indexOf(key, at + 1);
  }
  return false;
}

// Model names priceFor has seen that had no row of their own: no match at all, or
// only a bare-family fallback row such as 'opus'. lib/price-check.js starts a price
// check when this is not empty, and clears it after each successful check. Only
// names containing 'claude' are recorded: a non-Anthropic name can never get a row
// from the pricing page, and '<synthetic>' is a Claude Code internal tag.
const unmatched = new Set();

/** The recorded names, sorted. */
function unmatchedModels() {
  return [...unmatched].sort();
}

function clearUnmatched() {
  unmatched.clear();
}

/**
 * Look up a price row for a model name, at epoch ms `t` (default: current prices).
 * Returns null for anything unrecognized (synthetic/internal model tags, future
 * model names, etc) rather than guessing.
 */
function priceFor(modelName, t = Infinity) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  const row = table.find((r) => keyMatches(lower, r.match));
  if ((!row || row.match === row.family) && lower.includes('claude') && !modelName.startsWith('<')) unmatched.add(modelName);
  if (!row) return null;
  // Versions are in date order, so the last one that has started is in effect.
  let version = row.versions[0];
  for (const v of row.versions) if (v.from <= t) version = v;
  return flatten(row, version);
}

/**
 * Cache-write tokens for one usage record, split by cache lifetime.
 * Newer entries carry the 5m/1h split and older ones carry only the flat total.
 * The flat total is counted as 5-minute writes, the cheaper rate, rather than
 * guessing high. costForUsage and aggregate in lib/aggregate.js both call this, so the tokens
 * charged and the tokens reported are always the same count.
 */
function cacheWriteTokens(usage) {
  const split = usage.cache_creation || {};
  const write1h = split.ephemeral_1h_input_tokens || 0;
  let write5m = split.ephemeral_5m_input_tokens || 0;
  if (write5m === 0 && write1h === 0) write5m = usage.cache_creation_input_tokens || 0;
  return { write5m, write1h, total: write5m + write1h };
}

// A request's prompt is everything sent as input: fresh tokens, cache reads and
// cache writes. Output tokens are not part of it.
function promptTokens(usage) {
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + cacheWriteTokens(usage).total;
}

// Fast mode is a research preview on the Opus line only. A row with no fast
// rates ignores speed entirely. Fast is checked before the prompt-length tier.
// A row with `longPrompt` (Haiku 5.5) charges a request whose prompt is over
// `longPrompt.over` tokens at the long rates, and the cache multipliers apply to
// whichever input rate this returns.
function ratesFor(usage, row) {
  if (usage.speed === 'fast' && row.fast) return row.fast;
  if (row.longPrompt && promptTokens(usage) > row.longPrompt.over) return row.longPrompt;
  return row;
}

/**
 * Cost in USD for one usage record, given a model name.
 * `t` is the record's epoch ms, so a price change applies only from its effective date.
 * Returns { cost, priced } - priced is false when the model wasn't recognized,
 * so the caller can show "unpriced" instead of a silently-wrong $0.00.
 * familyRate is true when the price came from a bare-family row, so the model has no price of its own.
 */
function costForUsage(usage, modelName, t) {
  const row = priceFor(modelName, t);
  if (!row) return { cost: 0, priced: false };

  const rates = ratesFor(usage, row);
  const readMult = row.cacheReadMult != null ? row.cacheReadMult : DEFAULT_CACHE_READ_MULT;

  // 5-minute and 1-hour cache writes differ by 1.6x, so the split matters.
  const { write5m, write1h } = cacheWriteTokens(usage);

  const perMillion =
    (usage.input_tokens || 0) * rates.input +
    (usage.output_tokens || 0) * rates.output +
    write5m * rates.input * CACHE_WRITE_5M_MULT +
    write1h * rates.input * CACHE_WRITE_1H_MULT +
    (usage.cache_read_input_tokens || 0) * rates.input * readMult;

  return { cost: perMillion / 1e6, priced: true, familyRate: row.match === row.family };
}

/**
 * The output price in USD per token for one usage record, or null when the model
 * wasn't recognized. costForUsage charges output_tokens at this rate, and thinking
 * tokens are part of output_tokens.
 */
function outputRate(usage, modelName, t) {
  const row = priceFor(modelName, t);
  return row ? ratesFor(usage, row).output / 1e6 : null;
}

/** Short display label for a model name, e.g. "claude-opus-4-6-20260315" -> "Opus 4.6". */
function shortModelLabel(modelName) {
  if (!modelName) return 'unknown';
  const row = priceFor(modelName);
  // The major and minor are each capped at two digits, so a release date cannot be
  // read as either: 'claude-opus-4-20250514' is Opus 4, not Opus 4.20250514. An id
  // with no minor, such as 'claude-opus-5', shows its major alone.
  const versionMatch = modelName.match(/-(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/);
  const version = versionMatch ? versionMatch[1] + (versionMatch[2] ? `.${versionMatch[2]}` : '') : '';
  return row ? `${row.label}${version ? ' ' + version : ''}` : modelName;
}

// The UI colours each model by family, and MODEL_STYLE in
// public/charts/palette.mjs keys on exactly these six values. Rows carry family
// separately from match because match is now version-specific ('opus-5-5')
// while the family is not.
function familyFor(model) {
  const row = priceFor(model);
  return row ? row.family : 'other';
}

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function longPromptReason(row) {
  const lp = row.longPrompt;
  if (lp == null) return null;
  if (typeof lp === 'object' && Number.isInteger(lp.over) && lp.over > 0 && positive(lp.input) && positive(lp.output)) return null;
  return `${row.match}: longPrompt needs a whole-number over above zero and positive input and output prices`;
}

/**
 * Why a fetched or stored row cannot be used, or null when it can. The key must
 * be versioned ('opus-6', '3-5-haiku'): a bare family key would take over the
 * fallback row for every unknown model of that family.
 */
function validateRow(row) {
  if (!row || typeof row !== 'object') return 'row is not an object';
  if (typeof row.match !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(row.match)) return `match "${row.match}" is not a versioned key`;
  if (!KNOWN_FAMILIES.includes(row.family)) return `family "${row.family}" is not one of ${KNOWN_FAMILIES.join(', ')}`;
  if (!row.match.includes(row.family)) return `match "${row.match}" does not name its family "${row.family}"`;
  if (typeof row.label !== 'string' || !row.label) return `${row.match}: label is missing`;
  if (!positive(row.input)) return `${row.match}: input price must be above zero`;
  if (!positive(row.output) || row.output <= row.input) return `${row.match}: output price must be above the input price`;
  if (row.cacheReadMult != null && !(positive(row.cacheReadMult) && row.cacheReadMult <= 1)) return `${row.match}: cacheReadMult must be above 0 and at most 1`;
  if (row.fast != null && !(positive(row.fast.input) && positive(row.fast.output) && row.fast.output > row.fast.input)) return `${row.match}: fast rates must be above zero with output above input`;
  return longPromptReason(row);
}

module.exports = {
  priceFor, costForUsage, unmatchedModels, clearUnmatched, outputRate, cacheWriteTokens, shortModelLabel, familyFor,
  setSnapshots, currentRows, validateRow, localMidnight,
  KNOWN_FAMILIES, BUILT_IN_DATE, DEFAULT_CACHE_READ_MULT, CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT,
};
