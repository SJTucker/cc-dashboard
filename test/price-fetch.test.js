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
  assert.strictEqual(rows.length, 20);
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
  assert.deepStrictEqual(rows.find((r) => r.match === 'haiku-5-5'), {
    match: 'haiku-5-5', family: 'haiku', label: 'Haiku', name: 'Claude Haiku 5.5',
    input: 0.1, output: 0.5, longPrompt: { over: 100000, input: 0.5, output: 2.5 },
  });
  assert.strictEqual(rows.find((r) => r.match === 'sonnet-5-5').cacheReadMult, 0.05, 'Sonnet 5.5 cache reads are 0.05x');
});

test('against the built-in table the fixture changes nothing', () => {
  // This also checks PRICE_TABLE, including Haiku 5.5 and Sonnet 5.5, against the page as it was on 2026-10-14.
  const diff = diffPrices(parsePricingPage(PAGE).rows, currentRows());
  assert.deepStrictEqual(diff.added, []);
  assert.deepStrictEqual(diff.changed, []);
  assert.strictEqual(diff.unchanged, 20);
});

test('diffPrices reports a changed price with its old and new rows', () => {
  const page = withModelCells(PAGE, 'Claude Sonnet 4.6', ['$6 / MTok', '$7.50 / MTok', '$12 / MTok', '$0.60 / MTok', '$30 / MTok']);
  const diff = diffPrices(parsePricingPage(page).rows, currentRows());
  assert.strictEqual(diff.changed.length, 1);
  assert.strictEqual(diff.changed[0].before.input, 3);
  assert.strictEqual(diff.changed[0].after.input, 6);
  assert.strictEqual(diff.unchanged, 19);
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

// The live page's Fast mode table wrote "$8 USD / MTok" from October 2026.
test('a price written with USD reads the same as one without', () => {
  const page = PAGE.replace(/(\$[\d.]+) \/ MTok/g, '$1 USD / MTok');
  assert.notStrictEqual(page, PAGE, 'the fixture prices were found');
  assert.deepStrictEqual(parsePricingPage(page), parsePricingPage(PAGE));
});

test('a model from an unknown family is skipped, not refused', () => {
  const page = PAGE.replace(
    '| Claude Fable 5.1 ',
    '| Claude Zephyr 1 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |\n| Claude Fable 5.1 '
  );
  const { rows, skipped } = parsePricingPage(page);
  assert.strictEqual(rows.length, 20);
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
  refused(PAGE.split('\n').filter((l) => !/^\| Claude (Opus|Sonnet)/.test(l)).join('\n'), /only 7 models/);
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

// ---- prompt-length tier rows ----------------------------------------------
// Lines of the Model pricing table for Claude Haiku 5.5, which are the first
// lines containing the tier text (the Batch table lists them again further down).
function tierLineIndexes(md) {
  const lines = md.split('\n');
  const up = lines.findIndex((l) => l.includes('Claude Haiku 5.5 (for prompts up to'));
  const over = lines.findIndex((l) => l.includes('Claude Haiku 5.5 (for prompts over'));
  return { lines, up, over };
}

// Rewrites one line of the page, found by index, and joins the page again.
function editLine(md, which, fn) {
  const found = tierLineIndexes(md);
  found.lines[found[which]] = fn(found.lines[found[which]]);
  return found.lines.join('\n');
}

const refused = (md, pattern) => assert.throws(() => parsePricingPage(md), (err) => err instanceof PriceParseError && pattern.test(err.message));

test('the two Haiku 5.5 rows merge in either order into one row with a longPrompt tier', () => {
  const expected = parsePricingPage(PAGE).rows.find((r) => r.match === 'haiku-5-5');
  const { lines, up, over } = tierLineIndexes(PAGE);
  [lines[up], lines[over]] = [lines[over], lines[up]];
  const swapped = parsePricingPage(lines.join('\n'));
  assert.deepStrictEqual(swapped.rows.find((r) => r.match === 'haiku-5-5'), expected);
  assert.strictEqual(swapped.rows.filter((r) => r.match === 'haiku-5-5').length, 1);
  assert.deepStrictEqual(swapped.skipped, []);
});

test('a threshold written without a thousands separator reads the same', () => {
  const page = editLine(editLine(PAGE, 'up', (l) => l.replace('100,000', '100000')), 'over', (l) => l.replace('100,000', '100000'));
  assert.strictEqual(parsePricingPage(page).rows.find((r) => r.match === 'haiku-5-5').longPrompt.over, 100000);
});

test('a tiered model with one tier row, mismatched thresholds, a broken ratio or a repeated row is refused', () => {
  const { lines, up, over } = tierLineIndexes(PAGE);
  const without = (i) => lines.filter((_, n) => n !== i).join('\n');
  refused(without(over), /Haiku 5\.5.*"over" .*missing/);
  refused(without(up), /Haiku 5\.5.*"up to" .*missing/);
  refused(editLine(PAGE, 'over', (l) => l.replace('100,000', '200,000')), /thresholds/);
  refused(editLine(PAGE, 'over', (l) => l.replace('$0.625 / MTok', '$0.70 / MTok')), /1\.25x/);
  refused(editLine(PAGE, 'over', (l) => l.replace('$0.05 / MTok', '$0.10 / MTok')), /cache read/);
  refused(PAGE.replace(lines[up], `${lines[up]}\n${lines[up]}`), /listed twice/);
});

test('a name keyFor cannot read is skipped as an unrecognised model name', () => {
  const page = PAGE.replace(
    '| Claude Fable 5.1 ',
    '| Claude Mythos Preview | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |\n| Claude Fable 5.1 '
  );
  const { rows, skipped } = parsePricingPage(page);
  assert.strictEqual(rows.length, 20);
  assert.deepStrictEqual(skipped, [{ name: 'Claude Mythos Preview', reason: 'unrecognised model name' }]);
});

test('diffPrices counts a changed or missing longPrompt as a change', () => {
  const parsed = parsePricingPage(PAGE).rows;
  const tweak = (fn) => currentRows().map((r) => (r.match === 'haiku-5-5' ? fn(r) : r));
  const higher = diffPrices(parsed, tweak((r) => ({ ...r, longPrompt: { ...r.longPrompt, output: 3 } })));
  assert.deepStrictEqual(higher.changed.map((c) => c.after.match), ['haiku-5-5']);
  const none = diffPrices(parsed, tweak(({ longPrompt, ...rest }) => rest));
  assert.deepStrictEqual(none.changed.map((c) => c.after.match), ['haiku-5-5']);
});

test('a tiered name in the Fast mode table is skipped with a reason, and the page is still read', () => {
  const fastTier = '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.20 / MTok | $1 / MTok |';
  const page = PAGE.replace(/\| Claude Opus 5 \/ Claude Opus 4\.8 .*\n/, (row) => `${row}${fastTier}\n`);
  const { rows, skipped } = parsePricingPage(page);
  assert.strictEqual(rows.length, 20);
  assert.deepStrictEqual(skipped, [{ name: 'Claude Haiku 5.5 (for prompts up to 100,000 tokens)', reason: 'fast rates by prompt length are not supported' }]);
  assert.strictEqual(rows.find((r) => r.match === 'haiku-5-5').fast, undefined, 'no fast rate is set from a tiered name');
  assert.deepStrictEqual(rows.find((r) => r.match === 'opus-4-8').fast, { input: 10, output: 50 }, 'the untiered fast rows are still read');
});

test('a plain row and a tier row of the same model are refused as listed twice, in either order', () => {
  const plain = '| Claude Haiku 5.5 | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |';
  const { lines, up, over } = tierLineIndexes(PAGE);
  const plainFirst = [...lines.slice(0, up), plain, ...lines.slice(up)].join('\n');
  const plainLast = [...lines.slice(0, over + 1), plain, ...lines.slice(over + 1)].join('\n');
  refused(plainFirst, /Claude Haiku 5\.5 \(for prompts up to 100,000 tokens\) is listed twice/);
  refused(plainLast, /^Claude Haiku 5\.5 is listed twice/);
});

// Review Focus 1: a Fast mode row for a model the Model pricing table skipped.
test('a Fast mode row for a model the Model pricing table skipped is skipped too, not refused', () => {
  const zephyr = '| Claude Zephyr 1 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |';
  const page = PAGE
    .replace('| Claude Fable 5.1 ', `${zephyr}\n| Claude Fable 5.1 `)
    .replace(/\| Claude Opus 5 \/ Claude Opus 4\.8 .*\n/, (row) => `${row}| Claude Zephyr 1 | $2 / MTok | $10 / MTok |\n`);
  const { rows, skipped } = parsePricingPage(page);
  assert.strictEqual(rows.length, 20);
  assert.deepStrictEqual(skipped, [{ name: 'Claude Zephyr 1', reason: 'unknown model family "zephyr"' }], 'listed once, with the Model table reason');
  assert.deepStrictEqual(rows.find((r) => r.match === 'opus-4-8').fast, { input: 10, output: 50 });
});

// Review Focus 2: footnote markers on Fast mode names.
test('a Fast mode name with a footnote marker is read like a Model pricing name', () => {
  const page = PAGE.replace('| Claude Opus 5.5                 |', '| Claude Opus 5.5<sup>2</sup>             |');
  assert.notStrictEqual(page, PAGE, 'the fixture row was found');
  assert.deepStrictEqual(parsePricingPage(page).rows.find((r) => r.match === 'opus-5-5').fast, { input: 8, output: 40 });
});

test('a Fast mode row for a model the Model pricing table skipped as a tiered row is skipped too, not refused', () => {
  const zephyr = [
    '| Claude Zephyr 1 (for prompts up to 100,000 tokens) | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |',
    '| Claude Zephyr 1 (for prompts over 100,000 tokens) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |',
  ].join('\n');
  const page = PAGE
    .replace('| Claude Fable 5.1 ', `${zephyr}\n| Claude Fable 5.1 `)
    .replace(/\| Claude Opus 5 \/ Claude Opus 4\.8 .*\n/, (row) => `${row}| Claude Zephyr 1 | $2 / MTok | $10 / MTok |\n`);
  const { rows, skipped } = parsePricingPage(page);
  assert.strictEqual(rows.length, 20);
  assert.deepStrictEqual(skipped.map((s) => s.name), ['Claude Zephyr 1 (for prompts up to 100,000 tokens)', 'Claude Zephyr 1 (for prompts over 100,000 tokens)']);
});
