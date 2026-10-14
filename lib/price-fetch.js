'use strict';

// Reads Anthropic's pricing page, served as markdown, and turns its Model pricing
// and Fast mode pricing tables into rows shaped like PRICE_TABLE in lib/pricing.js.
// Anthropic has no pricing API: GET /v1/models returns no prices.

const {
  KNOWN_FAMILIES, validateRow, DEFAULT_CACHE_READ_MULT, CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT,
} = require('./pricing');

// The only URL this dashboard fetches. It is a constant, so nothing the page sends
// and no config file can point the server at another host.
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const FETCH_TIMEOUT_MS = 10_000;

// Fewer rows than this means the table was cut or split, not that models retired.
const MIN_ROWS = 10;

const MODEL_HEADER = ['Model', 'Base input tokens', '5m cache writes', '1h cache writes', 'Cache hits and refreshes', 'Output tokens'];
const FAST_HEADER = ['Model', 'Input', 'Output'];

class PriceParseError extends Error {}

async function fetchPricingPage() {
  const res = await fetch(PRICING_URL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${PRICING_URL} returned HTTP ${res.status}`);
  return res.text();
}

// The first markdown table under a heading line, as rows of trimmed cells. The
// |---| separator row is dropped. A heading before any table means no table.
function tableAfter(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new PriceParseError(`no "${heading}" section`);
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (/^#{1,6} /.test(lines[i])) throw new PriceParseError(`no table under "${heading}"`);
    i += 1;
  }
  const rows = [];
  for (; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
    const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
  }
  if (!rows.length) throw new PriceParseError(`no table under "${heading}"`);
  return rows;
}

function checkHeader(cells, expected, heading) {
  if (cells.join('|') !== expected.join('|')) {
    throw new PriceParseError(`"${heading}" columns are now ${cells.join(', ')}; expected ${expected.join(', ')}`);
  }
}

const stripSup = (cell) => cell.replace(/<sup>.*?<\/sup>/g, '').trim();

// 'Claude Opus 4.1 ([retired, ...](https://...))' -> 'Claude Opus 4.1'
function cleanName(cell) {
  return stripSup(cell).replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').trim();
}

function priceOf(cell, name) {
  const m = stripSup(cell).match(/^\$(\d+(?:\.\d+)?) \/ MTok$/);
  if (!m) throw new PriceParseError(`${name}: unreadable price "${cell}"`);
  return Number(m[1]);
}

/**
 * 'Claude Opus 5.5' -> opus-5-5. Model ids before Claude 4 put the version first
 * (claude-3-5-haiku-*), so 'Claude Haiku 3.5' -> 3-5-haiku, as in PRICE_TABLE.
 * Returns null for a name it cannot read as "Claude <Family> <version>".
 */
function keyFor(name) {
  const m = name.match(/^Claude ([A-Z][a-z]+) (\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const family = m[1].toLowerCase();
  const version = m[3] ? `${m[2]}-${m[3]}` : m[2];
  return { match: Number(m[2]) < 4 ? `${version}-${family}` : `${family}-${version}`, family, label: m[1] };
}

// 'Claude Haiku 5.5 (for prompts up to 100,000 tokens)' -> the name without the tier
// text, and { kind: 'up to' | 'over', over: 100000 }. A name with no tier text comes
// back with tier null.
const TIER_SUFFIX = /\s*\(for prompts (up to|over) ([\d,]+) tokens\)$/;

function splitTier(name) {
  const m = name.match(TIER_SUFFIX);
  if (!m) return { base: name, tier: null };
  const over = Number(m[2].replace(/,/g, ''));
  if (!Number.isInteger(over) || over <= 0) throw new PriceParseError(`${name}: unreadable prompt length`);
  return { base: name.slice(0, m.index), tier: { kind: m[1], over } };
}

const readMultOf = (row) => (row.cacheReadMult != null ? row.cacheReadMult : DEFAULT_CACHE_READ_MULT);

// The two page rows of one model ("up to" and "over") become one row: the "up to"
// row gives the base prices and the "over" row gives longPrompt. A page that lists
// only one of them, two different thresholds, or a different cache read ratio is
// refused, because the merged row would price one tier wrongly.
function mergeTiers(tiers) {
  const merged = [];
  for (const { up, over } of tiers.values()) {
    const row = (up || over).row;
    if (!up || !over) throw new PriceParseError(`${row.name}: the "${up ? 'over' : 'up to'}" prompt-length row is missing`);
    if (up.threshold !== over.threshold) throw new PriceParseError(`${row.name}: prompt-length thresholds differ (${up.threshold} and ${over.threshold})`);
    if (readMultOf(up.row) !== readMultOf(over.row)) throw new PriceParseError(`${row.name}: cache read ratio differs between the two prompt-length rows`);
    merged.push({ ...up.row, longPrompt: { over: up.threshold, input: over.row.input, output: over.row.output } });
  }
  return merged;
}

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

// One Model pricing row -> a PRICE_TABLE-shaped row. lib/pricing.js derives cache
// writes from global multipliers, so a row that breaks them cannot be priced.
function modelRow(cells, name, key) {
  if (cells.length !== MODEL_HEADER.length) throw new PriceParseError(`${name}: ${cells.length} columns, expected ${MODEL_HEADER.length}`);
  const [input, write5m, write1h, hit, output] = cells.slice(1).map((c) => priceOf(c, name));
  if (!near(write5m, input * CACHE_WRITE_5M_MULT) || !near(write1h, input * CACHE_WRITE_1H_MULT)) {
    throw new PriceParseError(`${name}: cache writes are not 1.25x and 2x the input price, which this dashboard's cost math assumes`);
  }
  const row = { ...key, name, input, output };
  const readMult = Math.round((hit / input) * 1e4) / 1e4;
  if (readMult !== DEFAULT_CACHE_READ_MULT) row.cacheReadMult = readMult;
  return row;
}

// 'Claude Opus 5 / Claude Opus 4.8' sets the same fast rates on both rows.
function addFastRates(markdown, rows) {
  const table = tableAfter(markdown, '### Fast mode pricing');
  checkHeader(table[0], FAST_HEADER, 'Fast mode pricing');
  for (const cells of table.slice(1)) {
    const input = priceOf(cells[1], cells[0]);
    const output = priceOf(cells[2], cells[0]);
    for (const name of cells[0].split('/').map(cleanName)) {
      const key = keyFor(name);
      const row = key && rows.find((r) => r.match === key.match);
      if (!row) throw new PriceParseError(`fast mode lists "${name}", which is not in the Model pricing table`);
      row.fast = { input, output };
    }
  }
}

// Reads one table row into `rows` (a plain model), `tiers` (one half of a tiered
// model) or `skipped`.
function readModelRow(cells, rows, tiers, skipped) {
  const full = cleanName(cells[0]);
  const { base, tier } = splitTier(full);
  const key = keyFor(base);
  if (!key) return skipped.push({ name: full, reason: 'unrecognised model name' });
  if (!KNOWN_FAMILIES.includes(key.family)) return skipped.push({ name: full, reason: `unknown model family "${key.family}"` });
  if (!tier) {
    if (rows.some((r) => r.match === key.match) || tiers.has(key.match)) throw new PriceParseError(`${base} is listed twice`);
    return rows.push(modelRow(cells, base, key));
  }
  const entry = tiers.get(key.match) || {};
  const slot = tier.kind === 'up to' ? 'up' : 'over';
  if (entry[slot] || rows.some((r) => r.match === key.match)) throw new PriceParseError(`${full} is listed twice`);
  entry[slot] = { row: modelRow(cells, base, key), threshold: tier.over };
  tiers.set(key.match, entry);
}

/**
 * Parse the pricing page. Returns the rows and the models skipped for an unknown
 * family or a name it cannot read. Throws PriceParseError when anything about the
 * page's shape or numbers fails a check: a refused parse must not change prices.
 */
function parsePricingPage(markdown) {
  const table = tableAfter(markdown, '## Model pricing');
  checkHeader(table[0], MODEL_HEADER, 'Model pricing');
  const rows = [];
  const skipped = [];
  const tiers = new Map(); // match -> { up, over }, each { row, threshold }
  for (const cells of table.slice(1)) readModelRow(cells, rows, tiers, skipped);
  rows.push(...mergeTiers(tiers));
  if (rows.length < MIN_ROWS) throw new PriceParseError(`only ${rows.length} models found, expected at least ${MIN_ROWS}`);
  addFastRates(markdown, rows);
  for (const row of rows) {
    const reason = validateRow(row);
    if (reason) throw new PriceParseError(reason);
  }
  return { rows, skipped };
}

function sameRates(a, b) {
  const fast = (r) => (r.fast ? `${r.fast.input}/${r.fast.output}` : '');
  const long = (r) => (r.longPrompt ? `${r.longPrompt.over}/${r.longPrompt.input}/${r.longPrompt.output}` : '');
  return a.input === b.input && a.output === b.output && readMultOf(a) === readMultOf(b) && fast(a) === fast(b) && long(a) === long(b);
}

/** Compare parsed rows with the prices in use, by match key. */
function diffPrices(parsedRows, current) {
  const added = [];
  const changed = [];
  let unchanged = 0;
  for (const row of parsedRows) {
    const now = current.find((r) => r.match === row.match);
    if (!now) added.push(row);
    else if (sameRates(row, now)) unchanged += 1;
    else changed.push({ before: now, after: row });
  }
  return { added, changed, unchanged };
}

module.exports = { PRICING_URL, PriceParseError, fetchPricingPage, parsePricingPage, keyFor, diffPrices };
