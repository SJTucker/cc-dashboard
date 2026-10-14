'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { priceFor, setSnapshots, unmatchedModels, clearUnmatched, BUILT_IN_DATE } = require('../lib/pricing');
const store = require('../lib/price-store');
const { changeDate, createPriceChecker, errorText } = require('../lib/price-check');
const helpers = require('./helpers');

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing-page.md'), 'utf8');
const NOW = () => new Date(2026, 9, 14, 12, 0); // 2026-10-14, local time
const SONNET_55_OLD = { match: 'sonnet-5-5', family: 'sonnet', label: 'Sonnet', name: 'Claude Sonnet 5.5', input: 2, output: 10 };

function useTempFile(t) {
  const file = path.join(helpers.tmpDir(t, 'check'), 'cc-dashboard', 'prices.json');
  t.mock.method(console, 'warn', () => {}); // loadPriceFile warns about an unreadable file
  t.after(() => { setSnapshots([]); clearUnmatched(); });
  store.loadPriceFile(file);
  clearUnmatched();
  return file;
}

// The owner's file as of 2026-10-14: one snapshot dated 2026-10-07 (or `effectiveFrom`)
// that holds a Sonnet 5.5 row with no cacheReadMult, and no lastCheck.
function writeOwnerFile(file, effectiveFrom = '2026-10-07') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [{ effectiveFrom, appliedAt: '2026-10-07T10:00:00.000Z', source: 'test', rows: [SONNET_55_OLD] }] }));
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
  assert.strictEqual(changeDate({ lastCheck: '2026-12-31', snapshots: [], today: '2027-01-05' }), '2027-01-01', 'year rollover');
  assert.strictEqual(changeDate({ lastCheck: null, snapshots: [{ effectiveFrom: '2027-12-31' }], today: '2028-01-05' }), '2028-01-01', 'year rollover from a snapshot date');
  assert.strictEqual(changeDate({ lastCheck: '2028-02-28', snapshots: [], today: '2028-03-05' }), '2028-02-29', 'leap day');
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
  assert.ok(console.warn.mock.calls.some((c) => /\[prices\] ignoring .*not valid JSON/.test(c.arguments[0])), 'the unreadable file was reported');
});

const CHANGED_PAGE = PAGE.replace('| Claude Fable 5.1 ', '| Claude Opus 6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |\n| Claude Fable 5.1 ');

test('newUnmatched lists the unmatched names no successful check has looked for', async (t) => {
  const file = useTempFile(t);
  let page = new Error('network down');
  const c = createPriceChecker({ file, now: NOW, fetchPage: async () => { if (page instanceof Error) throw page; return page; } });
  priceFor('claude-zeta-9');
  assert.deepStrictEqual(c.newUnmatched(), ['claude-zeta-9']);

  await c.check();
  assert.deepStrictEqual(c.newUnmatched(), ['claude-zeta-9'], 'a failed check looked for nothing');

  page = PAGE;
  await c.check();
  priceFor('claude-zeta-9'); // the next scan records the name again, because the page never names it
  assert.deepStrictEqual(c.newUnmatched(), [], 'the last successful check already looked for it');
  priceFor('claude-eta-1');
  assert.deepStrictEqual(c.newUnmatched(), ['claude-eta-1'], 'a name that appeared after the check is new');

  await c.check();
  assert.deepStrictEqual(c.newUnmatched(), [], 'both names were looked for by the second check');
  await c.check(); // no unmatched name when this check started
  priceFor('claude-zeta-9');
  assert.deepStrictEqual(c.newUnmatched(), ['claude-zeta-9'], 'each successful check replaces the remembered names');
});

test('a prices file that becomes unreadable after a good load keeps its snapshots, and the check reports the error', async (t) => {
  const file = useTempFile(t);
  writeOwnerFile(file);
  fs.writeFileSync(file, '{ not json');
  const { c } = checker(file);
  const result = await c.check();
  assert.strictEqual(result.kind, 'write');
  assert.match(c.state().lastError, /unreadable/);
  const source = store.pricesSource();
  assert.strictEqual(source.snapshots, 1, 'the applied snapshot is still in use');
  assert.strictEqual(source.kind, 'fetched');
  assert.match(source.error, /not valid JSON/);
  assert.strictEqual(priceFor('claude-sonnet-5-5', new Date(2026, 9, 9, 12).getTime()).cacheReadMult, undefined, 'the snapshot price, not the built-in 0.05x, is in use');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('an onApplied that throws is logged, and the check still reports success and clears the unmatched names', async (t) => {
  const file = useTempFile(t);
  writeOwnerFile(file);
  priceFor('claude-zeta-9');
  const logged = t.mock.method(console, 'error', () => {});
  const c = createPriceChecker({ file, now: NOW, fetchPage: async () => PAGE, onApplied: () => { throw new Error('scan memo broke'); } });
  const result = await c.check();
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.effectiveFrom, '2026-10-08');
  assert.strictEqual(read(file).snapshots.length, 2, 'the snapshot is written');
  assert.deepStrictEqual(unmatchedModels(), []);
  assert.strictEqual(c.state().lastError, null);
  assert.strictEqual(logged.mock.calls.length, 1);
  assert.match(logged.mock.calls[0].arguments[0], /onApplied failed: scan memo broke/);
});

test('a last snapshot dated after today stops the check with kind clock and writes nothing', async (t) => {
  const file = useTempFile(t);
  writeOwnerFile(file, '2026-10-20');
  const before = fs.readFileSync(file, 'utf8');
  const message = 'The last applied price change is dated 2026-10-20, after today. Check the system clock.';
  for (const page of [PAGE, CHANGED_PAGE]) {
    const { c, calls } = checker(file, page);
    const result = await c.check();
    assert.deepStrictEqual(result, { error: message, kind: 'clock' });
    assert.strictEqual(c.state().lastError, message);
    assert.strictEqual(calls.applied, 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'no snapshot and no lastCheck was written');
  }
});

test('stop() makes a running check write nothing and call no callback, and later checks do not fetch', async (t) => {
  const file = useTempFile(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = { fetch: 0, applied: 0 };
  const c = createPriceChecker({ file, now: NOW, fetchPage: async () => { calls.fetch += 1; await gate; return CHANGED_PAGE; }, onApplied: () => { calls.applied += 1; } });
  const running = c.check();
  c.stop();
  release();
  const result = await running;
  assert.strictEqual(result.kind, 'stopped');
  assert.strictEqual(fs.existsSync(file), false, 'nothing was written');
  assert.strictEqual(calls.applied, 0);
  assert.strictEqual(c.state().lastError, null, 'a stopped check is not a failure to show');

  assert.strictEqual((await c.check()).kind, 'stopped');
  assert.strictEqual(calls.fetch, 1, 'a check after stop() does not fetch');
});

test('stop() during a fetch that then fails reports stopped, not a fetch error', async (t) => {
  const file = useTempFile(t);
  let fail;
  const gate = new Promise((resolve, reject) => { fail = () => reject(new Error('socket closed')); });
  const c = createPriceChecker({ file, now: NOW, fetchPage: () => gate });
  const running = c.check();
  c.stop();
  fail();
  assert.strictEqual((await running).kind, 'stopped');
  assert.strictEqual(c.state().lastError, null);
});

test('errorText gives the message of an Error and the string of anything else', () => {
  assert.strictEqual(errorText(new Error('boom')), 'boom');
  assert.strictEqual(errorText('plain'), 'plain');
  assert.strictEqual(errorText(undefined), 'undefined');
  assert.strictEqual(errorText({ code: 7 }), '[object Object]');
});

test('a rejection that is not an Error still gives a readable message', async (t) => {
  const file = useTempFile(t);
  const fetching = createPriceChecker({ file, now: NOW, fetchPage: async () => { throw 'connection reset'; } });
  assert.match((await fetching.check()).error, /^Could not fetch .*: connection reset$/);
  const clock = createPriceChecker({ file, now: () => { throw 'clock broke'; }, fetchPage: async () => PAGE });
  assert.deepStrictEqual(await clock.check(), { error: 'clock broke', kind: 'internal' });
});

test('an error that is not a parse refusal is reported as kind internal and writes nothing', async (t) => {
  const file = useTempFile(t);
  const { c } = checker(file, null); // parsePricingPage(null) throws a TypeError
  const result = await c.check();
  assert.strictEqual(result.kind, 'internal');
  assert.match(result.error, /null/);
  assert.match(c.state().lastError, /null/);
  assert.strictEqual(fs.existsSync(file), false);
});

test('a prices folder that cannot be written is refused with kind write, for a snapshot and for a bare lastCheck', async (t) => {
  const locked = path.join(helpers.tmpDir(t, 'check'), 'locked');
  fs.mkdirSync(locked, { mode: 0o555 });
  const file = path.join(locked, 'cc-dashboard', 'prices.json');
  t.after(() => { setSnapshots([]); clearUnmatched(); });
  store.loadPriceFile(file);
  for (const page of [PAGE, CHANGED_PAGE]) {
    const { c, calls } = checker(file, page);
    const result = await c.check();
    assert.strictEqual(result.kind, 'write');
    assert.match(result.error, /^Could not write .*prices\.json/);
    assert.match(c.state().lastError, /Could not write/);
    assert.strictEqual(calls.applied, 0);
  }
});

// Review Focus 3: a 200 answer that is not the pricing page.
test('an empty body or a sign-in page is refused with kind parse, writes nothing and keeps the unmatched names', async (t) => {
  const file = useTempFile(t);
  priceFor('claude-zeta-9');
  for (const body of ['', '<html><body>Sign in to continue</body></html>']) {
    const { c } = checker(file, body);
    const result = await c.check();
    assert.strictEqual(result.kind, 'parse', JSON.stringify(body));
    assert.strictEqual(fs.existsSync(file), false);
    assert.deepStrictEqual(c.newUnmatched(), ['claude-zeta-9']);
  }
});

// Review Focus 4: the remembered names only silence the new-model trigger.
test('a later check still prices a model that an earlier check could not find on the page', async (t) => {
  const file = useTempFile(t);
  let page = PAGE;
  const c = createPriceChecker({ file, now: NOW, fetchPage: async () => page });
  priceFor('claude-opus-9'); // no opus-9 row yet: the bare opus row prices it
  await c.check();
  priceFor('claude-opus-9');
  assert.deepStrictEqual(c.newUnmatched(), [], 'the first check already looked for it');

  page = PAGE.replace('| Claude Fable 5.1 ', '| Claude Opus 9 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |\n| Claude Fable 5.1 ');
  const result = await c.check();
  assert.deepStrictEqual(result.added.map((r) => r.match), ['opus-9']);
  assert.strictEqual(priceFor('claude-opus-9').match, 'opus-9');
  assert.deepStrictEqual(unmatchedModels(), []);
});
