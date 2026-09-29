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
 * Returns null for a name with no version number.
 */
function keyFor(name) {
  const m = name.match(/^Claude ([A-Z][a-z]+) (\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const family = m[1].toLowerCase();
  const version = m[3] ? `${m[2]}-${m[3]}` : m[2];
  return { match: Number(m[2]) < 4 ? `${version}-${family}` : `${family}-${version}`, family, label: m[1] };
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

/**
 * Parse the pricing page. Returns the rows and the models skipped for an unknown
 * family or a name with no version. Throws PriceParseError when anything about the
 * page's shape or numbers fails a check: a refused parse must not change prices.
 */
function parsePricingPage(markdown) {
  const table = tableAfter(markdown, '## Model pricing');
  checkHeader(table[0], MODEL_HEADER, 'Model pricing');
  const rows = [];
  const skipped = [];
  for (const cells of table.slice(1)) {
    const name = cleanName(cells[0]);
    const key = keyFor(name);
    if (!key) skipped.push({ name, reason: 'name has no version number' });
    else if (!KNOWN_FAMILIES.includes(key.family)) skipped.push({ name, reason: `unknown model family "${key.family}"` });
    else if (rows.some((r) => r.match === key.match)) throw new PriceParseError(`${name} is listed twice`);
    else rows.push(modelRow(cells, name, key));
  }
  if (rows.length < MIN_ROWS) throw new PriceParseError(`only ${rows.length} models found, expected at least ${MIN_ROWS}`);
  addFastRates(markdown, rows);
  for (const row of rows) {
    const reason = validateRow(row);
    if (reason) throw new PriceParseError(reason);
  }
  return { rows, skipped };
}

function sameRates(a, b) {
  const readMult = (r) => (r.cacheReadMult != null ? r.cacheReadMult : DEFAULT_CACHE_READ_MULT);
  const fast = (r) => (r.fast ? `${r.fast.input}/${r.fast.output}` : '');
  return a.input === b.input && a.output === b.output && readMult(a) === readMult(b) && fast(a) === fast(b);
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
