'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { priceFor, setSnapshots, BUILT_IN_DATE } = require('../lib/pricing');
const store = require('../lib/price-store');
const helpers = require('./helpers');

const ROW = { match: 'sonnet-4-6', family: 'sonnet', label: 'Sonnet', name: 'Claude Sonnet 4.6', input: 6, output: 30 };
const NOW = new Date(2026, 9, 20, 12, 0);

// Each test gets its own prices file and starts from it. cc-dashboard/ does not
// exist yet, so a write has to create it.
function useTempFile(t) {
  const file = path.join(helpers.tmpDir(t, 'prices'), 'cc-dashboard', 'prices.json');
  t.mock.method(console, 'warn', () => {}); // loadPriceFile warns about an unreadable file; tests read the calls through warned()
  t.after(() => setSnapshots([]));
  store.loadPriceFile(file);
  return file;
}

// The messages console.warn received since useTempFile.
const warned = () => console.warn.mock.calls.map((c) => c.arguments[0]);

test('getPricesPath is under the config dir', () => {
  assert.strictEqual(store.getPricesPath('/cfg'), path.join('/cfg', 'cc-dashboard', 'prices.json'));
});

test('with no file the prices are built-in', (t) => {
  useTempFile(t);
  assert.deepStrictEqual(store.pricesSource(), { kind: 'built-in', date: BUILT_IN_DATE, appliedAt: null, snapshots: 0, error: null, lastCheck: null });
});

test('appendSnapshot writes the file and the new price applies from its date', (t) => {
  const file = useTempFile(t);
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW });
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.source.kind, 'fetched');
  assert.strictEqual(result.source.date, '2026-10-15');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(data.version, 1);
  assert.strictEqual(data.snapshots.length, 1);
  assert.strictEqual(data.snapshots[0].appliedAt, NOW.toISOString());
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 14).getTime()).input, 3);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 16).getTime()).input, 6);
});

test('a second append keeps the first snapshot', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [{ ...ROW, input: 4, output: 20 }], source: 'test', file, now: NOW });
  store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).snapshots.length, 2);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 12).getTime()).input, 4);
});

test('appendSnapshot refuses a bad, future or out-of-order date and writes nothing', (t) => {
  const file = useTempFile(t);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-9-1', rows: [ROW], source: 'test', file, now: NOW }).error, /YYYY-MM-DD/);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-02-30', rows: [ROW], source: 'test', file, now: NOW }).error, /YYYY-MM-DD/);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-21', rows: [ROW], source: 'test', file, now: NOW }).error, /future/);
  assert.strictEqual(fs.existsSync(file), false);
  store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW });
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-14', rows: [ROW], source: 'test', file, now: NOW }).error, /2026-10-15/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).snapshots.length, 1);
});

test('appendSnapshot refuses an invalid row', (t) => {
  const file = useTempFile(t);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [{ ...ROW, output: 1 }], source: 'test', file, now: NOW }).error, /output/);
});

test('a corrupt file is ignored: built-in prices, the reason is shown, and Apply refuses to overwrite it', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const source = store.loadPriceFile(file);
  assert.strictEqual(source.kind, 'built-in');
  assert.strictEqual(source.error, 'not valid JSON');
  assert.deepStrictEqual(warned(), [`[prices] ignoring ${file}: not valid JSON`]);
  assert.strictEqual(priceFor('claude-sonnet-4-6').input, 3);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW }).error, /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json', 'the file is left for the owner to fix');
});

test('one bad row makes the whole file ignored', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-10', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] },
    { effectiveFrom: '2026-10-15', appliedAt: NOW.toISOString(), source: 'test', rows: [{ ...ROW, input: -1 }] },
  ] }));
  const source = store.loadPriceFile(file);
  assert.strictEqual(source.kind, 'built-in');
  assert.match(source.error, /snapshot 2/);
  assert.match(warned()[0], /^\[prices\] ignoring .*snapshot 2/);
  assert.strictEqual(priceFor('claude-sonnet-4-6').input, 3, 'not even the valid first snapshot is used');
});

test('snapshots out of date order make the file ignored', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-15', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] },
    { effectiveFrom: '2026-10-10', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] },
  ] }));
  assert.match(store.loadPriceFile(file).error, /before the one above it/);
});

test('appendSnapshot reloads the file first, so a hand-added snapshot survives the next append', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-05', appliedAt: NOW.toISOString(), source: 'hand', rows: [ROW] },
  ] }));
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [{ ...ROW, input: 9, output: 45 }], source: 'test', file, now: NOW });
  assert.strictEqual(result.error, undefined);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(data.snapshots.length, 2, 'the hand-written snapshot must survive');
  assert.strictEqual(data.snapshots[0].effectiveFrom, '2026-10-05');
  assert.strictEqual(data.snapshots[0].source, 'hand');
});

test('appendSnapshot reloads the file first, so an append dated before a hand-added snapshot is refused', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-05', appliedAt: NOW.toISOString(), source: 'hand', rows: [ROW] },
  ] }));
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-01', rows: [ROW], source: 'test', file, now: NOW });
  assert.match(result.error, /2026-10-05/);
});

test('appendSnapshot reloads the file first, so a file corrupted after the last load is refused, not overwritten', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW });
  assert.match(result.error, /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json', 'the file is left for the owner to fix');
});

test('a write that cannot succeed returns an error instead of throwing', (t) => {
  const dir = helpers.tmpDir(t, 'prices');
  // Read-only config dir: the file itself is missing (a harmless ENOENT on
  // load), but mkdirSync cannot create cc-dashboard/ to hold it.
  // removeTree restores the mode before deleting, so no chmod hook is needed.
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked, { mode: 0o555 });
  const file = path.join(locked, 'cc-dashboard', 'prices.json');
  t.after(() => setSnapshots([]));
  store.loadPriceFile(file);
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW });
  assert.match(result.error, /Could not write/);
});

// ---- lastCheck --------------------------------------------------------------
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('recordCheck on a missing file creates it with lastCheck and no snapshots', (t) => {
  const file = useTempFile(t);
  const result = store.recordCheck({ file, date: '2026-10-14' });
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(read(file), { version: 1, lastCheck: '2026-10-14', snapshots: [] });
  assert.strictEqual(result.source.lastCheck, '2026-10-14');
  assert.strictEqual(result.source.kind, 'built-in');
  assert.strictEqual(store.pricesSource().lastCheck, '2026-10-14');
});

test('recordCheck keeps every snapshot and rewrites only lastCheck', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [{ ...ROW, input: 4, output: 20 }], source: 'test', file, now: NOW });
  store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW });
  const before = read(file).snapshots;
  store.recordCheck({ file, date: '2026-10-16' });
  assert.deepStrictEqual(read(file).snapshots, before);
  assert.strictEqual(read(file).lastCheck, '2026-10-16');
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 17).getTime()).input, 6, 'prices still apply');
});

test('appendSnapshot writes lastCheck with the snapshot, and keeps an existing lastCheck when none is given', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [ROW], source: 'test', file, now: NOW, lastCheck: '2026-10-12' });
  assert.strictEqual(read(file).lastCheck, '2026-10-12');
  store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [{ ...ROW, input: 7, output: 35 }], source: 'test', file, now: NOW });
  assert.strictEqual(read(file).lastCheck, '2026-10-12', 'an append with no lastCheck must not drop the stored one');
  assert.strictEqual(read(file).snapshots.length, 2);
});

test('appendSnapshot and recordCheck refuse a lastCheck or date that is not a real date', (t) => {
  const file = useTempFile(t);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW, lastCheck: '2026-02-30' }).error, /lastCheck/);
  assert.match(store.recordCheck({ file, date: '2026-10-1' }).error, /YYYY-MM-DD/);
  assert.strictEqual(fs.existsSync(file), false, 'nothing was written');
});

test('a file whose lastCheck is not a real date is ignored as a whole, and neither write overwrites it', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bad of ['2026-02-30', '2026-10-1', 20261014, true]) {
    const text = JSON.stringify({ version: 1, lastCheck: bad, snapshots: [{ effectiveFrom: '2026-10-10', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] }] });
    fs.writeFileSync(file, text);
    const source = store.loadPriceFile(file);
    assert.strictEqual(source.kind, 'built-in', String(bad));
    assert.match(source.error, /lastCheck/);
    assert.match(store.recordCheck({ file, date: '2026-10-14' }).error, /unreadable/);
    assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW }).error, /unreadable/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the file is left for the owner to fix');
  }
});

test('recordCheck refuses to write over a corrupt file', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.match(store.recordCheck({ file, date: '2026-10-14' }).error, /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('priceSnapshots returns the snapshots of the last load', (t) => {
  const file = useTempFile(t);
  assert.deepStrictEqual(store.priceSnapshots(), []);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [ROW], source: 'test', file, now: NOW });
  assert.deepStrictEqual(store.priceSnapshots().map((s) => s.effectiveFrom), ['2026-10-10']);
});

test('a file that becomes unreadable after a good load keeps the last good prices and reports the error', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [{ ...ROW, input: 4, output: 20 }], source: 'test', file, now: NOW, lastCheck: '2026-10-12' });
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ not json');

  const source = store.loadPriceFile(file);
  assert.strictEqual(source.kind, 'fetched', 'the snapshot from the last good read is still applied');
  assert.strictEqual(source.snapshots, 1);
  assert.strictEqual(source.lastCheck, '2026-10-12');
  assert.strictEqual(source.error, 'not valid JSON');
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 12).getTime()).input, 4);
  assert.strictEqual(warned().at(-1), `[prices] ignoring ${file}: not valid JSON; keeping the prices from the last good read`);
  assert.match(store.recordCheck({ file, date: '2026-10-14' }).error, /unreadable/, 'a write still refuses to overwrite it');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');

  fs.writeFileSync(file, good);
  assert.strictEqual(store.loadPriceFile(file).error, null, 'a repaired file clears the error');
});

test('an unreadable file does not take the snapshots another file was loaded with', (t) => {
  const first = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [{ ...ROW, input: 4, output: 20 }], source: 'test', file: first, now: NOW });
  const second = path.join(helpers.tmpDir(t, 'prices-other'), 'cc-dashboard', 'prices.json');
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(second, '{ not json');
  const source = store.loadPriceFile(second);
  assert.strictEqual(source.kind, 'built-in', 'a file unreadable at its first load means built-in prices');
  assert.strictEqual(source.snapshots, 0);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 12).getTime()).input, 3);
});

test('priceSnapshots returns copies, so changing the result leaves the loaded prices alone', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [ROW], source: 'test', file, now: NOW });
  const copy = store.priceSnapshots();
  copy[0].effectiveFrom = '1999-01-01';
  copy[0].rows[0].input = 99;
  copy.push({ effectiveFrom: '2030-01-01' });
  const again = store.priceSnapshots();
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].effectiveFrom, '2026-10-10');
  assert.strictEqual(again[0].rows[0].input, ROW.input);
});

test('appendSnapshot and recordCheck word an unreadable file the same way', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const expected = `The prices file is unreadable (not valid JSON). Fix or remove ${file} first.`;
  assert.strictEqual(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', file, now: NOW }).error, expected);
  assert.strictEqual(store.recordCheck({ file, date: '2026-10-14' }).error, expected);
});

test('recordCheck with a bad date leaves an existing file as it was', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [ROW], source: 'test', file, now: NOW, lastCheck: '2026-10-12' });
  const before = fs.readFileSync(file, 'utf8');
  assert.match(store.recordCheck({ file, date: '2026-02-30' }).error, /YYYY-MM-DD/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(store.pricesSource().lastCheck, '2026-10-12');
});

test('recordCheck returns an error instead of throwing when the folder cannot be written', (t) => {
  const locked = path.join(helpers.tmpDir(t, 'prices'), 'locked');
  fs.mkdirSync(locked, { mode: 0o555 });
  const file = path.join(locked, 'cc-dashboard', 'prices.json');
  t.after(() => setSnapshots([]));
  store.loadPriceFile(file);
  const result = store.recordCheck({ file, date: '2026-10-14' });
  assert.match(result.error, /^Could not write .*prices\.json/);
  assert.strictEqual(fs.existsSync(path.join(locked, 'cc-dashboard')), false);
});

// Review Focus 5: the file is deleted while the server runs.
test('a prices file deleted after a good load means built-in prices, with no error, and the next write recreates it', (t) => {
  const file = useTempFile(t);
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [{ ...ROW, input: 4, output: 20 }], source: 'test', file, now: NOW });
  fs.rmSync(file);
  const source = store.loadPriceFile(file);
  assert.deepStrictEqual([source.kind, source.snapshots, source.error], ['built-in', 0, null]);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 12).getTime()).input, 3);
  assert.strictEqual(store.recordCheck({ file, date: '2026-10-14' }).error, undefined);
  assert.deepStrictEqual(read(file), { version: 1, lastCheck: '2026-10-14', snapshots: [] });
});
