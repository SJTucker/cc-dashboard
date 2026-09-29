'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { currentRows } = require('../lib/pricing');
const { PRICING_URL, PriceParseError, fetchPricingPage, parsePricingPage, keyFor, diffPrices } = require('../lib/price-fetch');

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing-page.md'), 'utf8');

// Replaces price cells in the first table row named `name`, which is the row in the
// Model pricing table. `values` is [input, 5m write, 1h write, cache hit, output],
// with null to keep a cell.
function withModelCells(md, name, values) {
  let done = false;
  return md.split('\n').map((line) => {
    const cells = line.split('|');
    if (done || cells.length < 3 || cells[1].trim() !== name) return line;
    done = true;
    values.forEach((v, i) => { if (v != null) cells[i + 2] = ` ${v} `; });
    return cells.join('|');
  }).join('\n');
}

test('keyFor maps display names to PRICE_TABLE keys', () => {
  assert.deepStrictEqual(keyFor('Claude Opus 5.5'), { match: 'opus-5-5', family: 'opus', label: 'Opus' });
  assert.deepStrictEqual(keyFor('Claude Opus 4'), { match: 'opus-4', family: 'opus', label: 'Opus' });
  assert.deepStrictEqual(keyFor('Claude Haiku 3.5'), { match: '3-5-haiku', family: 'haiku', label: 'Haiku' }, 'the 3.x ids put the version first');
  assert.strictEqual(keyFor('Claude Mythos Preview'), null);
});

test('the fixture parses to every model with its cache and fast rates', () => {
  const { rows, skipped } = parsePricingPage(PAGE);
  assert.strictEqual(rows.length, 19);
  assert.deepStrictEqual(skipped, []);
  assert.deepStrictEqual(rows.find((r) => r.match === 'opus-5-5'), {
    match: 'opus-5-5', family: 'opus', label: 'Opus', name: 'Claude Opus 5.5',
    input: 4, output: 20, cacheReadMult: 0.05, fast: { input: 8, output: 40 },
  });
  assert.strictEqual(rows.find((r) => r.match === 'fable-5-1').cacheReadMult, 0.025);
  assert.strictEqual(rows.find((r) => r.match === 'sonnet-5').cacheReadMult, undefined, 'the default 0.1x is left off, as in PRICE_TABLE');
  assert.strictEqual(rows.find((r) => r.match === 'sonnet-5').input, 2, 'a footnote marker on a price is ignored');
  assert.deepStrictEqual(rows.find((r) => r.match === 'opus-4-8').fast, { input: 10, output: 50 }, '"Opus 5 / Opus 4.8" sets both');
  assert.strictEqual(rows.find((r) => r.match === 'opus-4-7').fast, undefined);
  assert.strictEqual(rows.find((r) => r.match === 'opus-4-1').name, 'Claude Opus 4.1', 'the retired-link note is stripped');
  assert.strictEqual(rows.find((r) => r.match === '3-5-haiku').input, 0.8);
});

test('against the built-in table the fixture adds Sonnet 5.5 and changes nothing', () => {
  // This also checks PRICE_TABLE against the page as it was on 2026-09-29.
  const diff = diffPrices(parsePricingPage(PAGE).rows, currentRows());
  assert.deepStrictEqual(diff.added.map((r) => r.match), ['sonnet-5-5']);
  assert.deepStrictEqual(diff.changed, []);
  assert.strictEqual(diff.unchanged, 18);
});

test('diffPrices reports a changed price with its old and new rows', () => {
  const page = withModelCells(PAGE, 'Claude Sonnet 4.6', ['$6 / MTok', '$7.50 / MTok', '$12 / MTok', '$0.60 / MTok', '$30 / MTok']);
  const diff = diffPrices(parsePricingPage(page).rows, currentRows());
  assert.strictEqual(diff.changed.length, 1);
  assert.strictEqual(diff.changed[0].before.input, 3);
  assert.strictEqual(diff.changed[0].after.input, 6);
  assert.strictEqual(diff.unchanged, 17);
});

test('diffPrices counts a removed fast rate as a change', () => {
  const page = PAGE.replace('Claude Opus 5 / Claude Opus 4.8', 'Claude Opus 5                  ');
  const diff = diffPrices(parsePricingPage(page).rows, currentRows());
  assert.deepStrictEqual(diff.changed.map((c) => c.after.match), ['opus-4-8']);
});

test('a footnote marker on a model name is stripped', () => {
  const page = PAGE.replace('Claude Haiku 4.5 ', 'Claude Haiku 4.5<sup>4</sup> ');
  const row = parsePricingPage(page).rows.find((r) => r.match === 'haiku-4-5');
  assert.strictEqual(row.name, 'Claude Haiku 4.5');
});

test('a model from an unknown family is skipped, not refused', () => {
  const page = PAGE.replace(
    '| Claude Fable 5.1 ',
    '| Claude Zephyr 1 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |\n| Claude Fable 5.1 '
  );
  const { rows, skipped } = parsePricingPage(page);
  assert.strictEqual(rows.length, 19);
  assert.deepStrictEqual(skipped, [{ name: 'Claude Zephyr 1', reason: 'unknown model family "zephyr"' }]);
});

test('a page that changed shape is refused with the reason', () => {
  const refused = (md, pattern) => assert.throws(() => parsePricingPage(md), (err) => err instanceof PriceParseError && pattern.test(err.message));
  refused(PAGE.replace('## Model pricing', '## Model prices'), /Model pricing/);
  refused(PAGE.replace('Base input tokens', 'Input tokens'), /columns/);
  refused(PAGE.replace('### Fast mode pricing', '### Fast pricing'), /Fast mode pricing/);
  refused(withModelCells(PAGE, 'Claude Opus 5.5', ['Contact sales']), /Contact sales/);
  refused(withModelCells(PAGE, 'Claude Opus 5.5', [null, '$6 / MTok']), /1.25x/);
  refused(withModelCells(PAGE, 'Claude Opus 5.5', [null, null, null, null, '$3 / MTok']), /output/);
  refused(PAGE.replace('Claude Opus 5 / Claude Opus 4.8', 'Claude Opus 5 / Claude Opus 4.9'), /Opus 4\.9/);
  refused(PAGE.split('\n').filter((l) => !/^\| Claude (Opus|Sonnet)/.test(l)).join('\n'), /only 6 models/);
});

test('fetchPricingPage requests the constant URL, refuses redirects, and fails on a bad status', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return new Response('# page', { status: 200 }); };
  assert.strictEqual(await fetchPricingPage(), '# page');
  assert.strictEqual(calls[0].url, PRICING_URL);
  assert.strictEqual(calls[0].opts.redirect, 'error');
  assert.ok(calls[0].opts.signal, 'the request has a timeout');
  globalThis.fetch = async () => new Response('nope', { status: 503 });
  await assert.rejects(fetchPricingPage(), /503/);
});
