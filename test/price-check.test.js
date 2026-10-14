'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { priceFor, setSnapshots, unmatchedModels, clearUnmatched, BUILT_IN_DATE } = require('../lib/pricing');
const store = require('../lib/price-store');
const { changeDate, createPriceChecker } = require('../lib/price-check');
const helpers = require('./helpers');

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing-page.md'), 'utf8');
const NOW = () => new Date(2026, 9, 14, 12, 0); // 2026-10-14, local time
const SONNET_55_OLD = { match: 'sonnet-5-5', family: 'sonnet', label: 'Sonnet', name: 'Claude Sonnet 5.5', input: 2, output: 10 };

function useTempFile(t) {
  const file = path.join(helpers.tmpDir(t, 'check'), 'cc-dashboard', 'prices.json');
  t.after(() => { setSnapshots([]); clearUnmatched(); });
  store.loadPriceFile(file);
  clearUnmatched();
  return file;
}

// The owner's file as of 2026-10-14: one snapshot dated 2026-10-07 that holds a
// Sonnet 5.5 row with no cacheReadMult, and no lastCheck.
function writeOwnerFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [{ effectiveFrom: '2026-10-07', appliedAt: '2026-10-07T10:00:00.000Z', source: 'test', rows: [SONNET_55_OLD] }] }));
  store.loadPriceFile(file);
}

function checker(file, page = PAGE) {
  const calls = { fetch: 0, applied: 0 };
  const c = createPriceChecker({
    file, now: NOW,
    fetchPage: async () => { calls.fetch += 1; if (page instanceof Error) throw page; return page; },
    onApplied: () => { calls.applied += 1; },
  });
  return { c, calls };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('changeDate is the day after the last check, else after the last snapshot, else after the built-in date', () => {
  assert.strictEqual(BUILT_IN_DATE, '2026-10-14', 'this table assumes the built-in date set in Task 3');
  assert.strictEqual(changeDate({ lastCheck: '2026-10-10', snapshots: [], today: '2026-10-14' }), '2026-10-11');
  assert.strictEqual(changeDate({ lastCheck: null, snapshots: [{ effectiveFrom: '2026-10-07' }], today: '2026-10-14' }), '2026-10-08');
  assert.strictEqual(changeDate({ lastCheck: null, snapshots: [], today: '2026-10-20' }), '2026-10-15');
  assert.strictEqual(changeDate({ lastCheck: '2026-10-31', snapshots: [], today: '2026-11-05' }), '2026-11-01', 'month rollover');
});

test('changeDate is never later than today and never earlier than the last snapshot', () => {
  assert.strictEqual(changeDate({ lastCheck: '2026-10-14', snapshots: [], today: '2026-10-14' }), '2026-10-14', 'checked today: the change is today');
  assert.strictEqual(changeDate({ lastCheck: '2026-10-30', snapshots: [], today: '2026-10-14' }), '2026-10-14', 'a lastCheck in the future (clock set back) is capped at today');
  assert.strictEqual(changeDate({ lastCheck: '2026-10-01', snapshots: [{ effectiveFrom: '2026-10-07' }], today: '2026-10-14' }), '2026-10-07');
});

test('the owner\'s first check changes Sonnet 5.5 to 0.05x from 2026-10-08 and writes lastCheck', async (t) => {
  const file = useTempFile(t);
  writeOwnerFile(file);
  const before = new Date(2026, 9, 7, 12).getTime();
  const after = new Date(2026, 9, 9, 12).getTime();
  assert.strictEqual(priceFor('claude-sonnet-5-5', after).cacheReadMult, undefined, 'the snapshot row has no cacheReadMult');

  const { c, calls } = checker(file);
  const result = await c.check();
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(result.added, []);
  assert.deepStrictEqual(result.changed.map((x) => x.after.match), ['sonnet-5-5']);
  assert.strictEqual(result.changed[0].after.cacheReadMult, 0.05);
  assert.strictEqual(result.effectiveFrom, '2026-10-08');
  assert.strictEqual(calls.applied, 1);
  const saved = read(file);
  assert.strictEqual(saved.lastCheck, '2026-10-14');
  assert.strictEqual(saved.snapshots.length, 2);
  assert.strictEqual(priceFor('claude-sonnet-5-5', before).cacheReadMult, undefined, 'usage before the change date keeps its price');
  assert.strictEqual(priceFor('claude-sonnet-5-5', after).cacheReadMult, 0.05);
  assert.deepStrictEqual(c.state(), { lastCheck: '2026-10-14', lastAttemptAt: NOW().getTime(), lastError: null, running: false });
});

test('a model new to the page is added for all dates and dated by changeDate', async (t) => {
  const file = useTempFile(t);
  const page = PAGE.replace('| Claude Fable 5.1 ', '| Claude Opus 6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |\n| Claude Fable 5.1 ');
  const { c } = checker(file, page);
  const result = await c.check();
  assert.deepStrictEqual(result.added.map((r) => r.match), ['opus-6']);
  assert.strictEqual(result.effectiveFrom, '2026-10-14', 'capped at today');
  assert.strictEqual(priceFor('claude-opus-6', new Date(2026, 0, 1).getTime()).input, 5, 'a new model is priced for all dates');
});

test('a second check right after the first applies nothing and writes no second snapshot', async (t) => {
  const file = useTempFile(t);
  writeOwnerFile(file);
  const { c, calls } = checker(file);
  await c.check();
  const again = await c.check();
  assert.deepStrictEqual(again.changed, []);
  assert.deepStrictEqual(again.added, []);
  assert.strictEqual(again.effectiveFrom, null);
  assert.strictEqual(read(file).snapshots.length, 2, 'still one snapshot from the first check');
  assert.strictEqual(calls.applied, 1, 'onApplied runs only when something changed');
  assert.strictEqual(calls.fetch, 2);
});

test('a check that finds nothing new writes lastCheck alone', async (t) => {
  const file = useTempFile(t);
  const { c, calls } = checker(file);
  const result = await c.check();
  assert.deepStrictEqual([result.added, result.changed, result.effectiveFrom], [[], [], null]);
  assert.strictEqual(result.unchanged, 20);
  assert.deepStrictEqual(read(file), { version: 1, lastCheck: '2026-10-14', snapshots: [] });
  assert.strictEqual(calls.applied, 0);
});

test('two concurrent check() calls make one fetch and share one result', async (t) => {
  const file = useTempFile(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = { fetch: 0 };
  const c = createPriceChecker({ file, now: NOW, fetchPage: async () => { calls.fetch += 1; await gate; return PAGE; } });
  const first = c.check();
  const second = c.check();
  assert.strictEqual(c.state().running, true);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(calls.fetch, 1);
  assert.strictEqual(a, b);
  assert.strictEqual(c.state().running, false);
});

test('a failed fetch changes nothing, sets lastError and keeps the unmatched set; the next good check clears both', async (t) => {
  const file = useTempFile(t);
  priceFor('claude-zeta-9');
  let page = new Error('network down');
  const c = createPriceChecker({ file, now: NOW, fetchPage: async () => { if (page instanceof Error) throw page; return page; } });

  const failed = await c.check();
  assert.strictEqual(failed.kind, 'fetch');
  assert.match(failed.error, /Could not fetch .*network down/);
  assert.strictEqual(fs.existsSync(file), false, 'no lastCheck and no snapshot written');
  assert.match(c.state().lastError, /network down/);
  assert.strictEqual(c.state().lastAttemptAt, NOW().getTime());
  assert.deepStrictEqual(unmatchedModels(), ['claude-zeta-9']);

  page = PAGE;
  const good = await c.check();
  assert.strictEqual(good.error, undefined);
  assert.strictEqual(c.state().lastError, null);
  assert.deepStrictEqual(unmatchedModels(), []);
});

test('a page that does not parse is refused with kind parse and writes nothing', async (t) => {
  const file = useTempFile(t);
  const { c } = checker(file, '# nothing here');
  const result = await c.check();
  assert.strictEqual(result.kind, 'parse');
  assert.match(result.error, /prices are unchanged/);
  assert.strictEqual(fs.existsSync(file), false);
  assert.match(c.state().lastError, /prices are unchanged/);
});

test('an unreadable prices file is refused with kind write and left as it is', async (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const { c } = checker(file);
  const result = await c.check();
  assert.strictEqual(result.kind, 'write');
  assert.match(result.error, /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
});
