'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { priceFor, setSnapshots, BUILT_IN_DATE } = require('../lib/pricing');
const store = require('../lib/price-store');

const ROW = { match: 'sonnet-4-6', family: 'sonnet', label: 'Sonnet', name: 'Claude Sonnet 4.6', input: 6, output: 30 };
const NOW = new Date(2026, 9, 20, 12, 0);

// Points CLAUDE_CONFIG_DIR at dir for one test and puts it back afterwards.
function useConfigDir(t, dir) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    setSnapshots([]);
  });
}

// Each test gets its own config dir, so its own prices file, and starts from it.
// cc-dashboard/ does not exist yet, so a write has to create it.
function useTempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-prices-'));
  useConfigDir(t, dir);
  store.loadPriceFile();
  return path.join(dir, 'cc-dashboard', 'prices.json');
}

test('getPricesPath is under CLAUDE_CONFIG_DIR, then ~/.claude', (t) => {
  useConfigDir(t, '/tmp/cfg');
  assert.strictEqual(store.getPricesPath(), path.join('/tmp/cfg', 'cc-dashboard', 'prices.json'));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.strictEqual(store.getPricesPath(), path.join(os.homedir(), '.claude', 'cc-dashboard', 'prices.json'));
});

test('with no file the prices are built-in', (t) => {
  useTempFile(t);
  assert.deepStrictEqual(store.pricesSource(), { kind: 'built-in', date: BUILT_IN_DATE, appliedAt: null, snapshots: 0, error: null });
});

test('appendSnapshot writes the file and the new price applies from its date', (t) => {
  const file = useTempFile(t);
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', now: NOW });
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
  store.appendSnapshot({ effectiveFrom: '2026-10-10', rows: [{ ...ROW, input: 4, output: 20 }], source: 'test', now: NOW });
  store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', now: NOW });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).snapshots.length, 2);
  assert.strictEqual(priceFor('claude-sonnet-4-6', new Date(2026, 9, 12).getTime()).input, 4);
});

test('appendSnapshot refuses a bad, future or out-of-order date and writes nothing', (t) => {
  const file = useTempFile(t);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-9-1', rows: [ROW], source: 'test', now: NOW }).error, /YYYY-MM-DD/);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-02-30', rows: [ROW], source: 'test', now: NOW }).error, /YYYY-MM-DD/);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-21', rows: [ROW], source: 'test', now: NOW }).error, /future/);
  assert.strictEqual(fs.existsSync(file), false);
  store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', now: NOW });
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-14', rows: [ROW], source: 'test', now: NOW }).error, /2026-10-15/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).snapshots.length, 1);
});

test('appendSnapshot refuses an invalid row', (t) => {
  useTempFile(t);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [{ ...ROW, output: 1 }], source: 'test', now: NOW }).error, /output/);
});

test('a corrupt file is ignored: built-in prices, the reason is shown, and Apply refuses to overwrite it', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const source = store.loadPriceFile();
  assert.strictEqual(source.kind, 'built-in');
  assert.strictEqual(source.error, 'not valid JSON');
  assert.strictEqual(priceFor('claude-sonnet-4-6').input, 3);
  assert.match(store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', now: NOW }).error, /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json', 'the file is left for the owner to fix');
});

test('one bad row makes the whole file ignored', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-10', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] },
    { effectiveFrom: '2026-10-15', appliedAt: NOW.toISOString(), source: 'test', rows: [{ ...ROW, input: -1 }] },
  ] }));
  const source = store.loadPriceFile();
  assert.strictEqual(source.kind, 'built-in');
  assert.match(source.error, /snapshot 2/);
  assert.strictEqual(priceFor('claude-sonnet-4-6').input, 3, 'not even the valid first snapshot is used');
});

test('snapshots out of date order make the file ignored', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-15', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] },
    { effectiveFrom: '2026-10-10', appliedAt: NOW.toISOString(), source: 'test', rows: [ROW] },
  ] }));
  assert.match(store.loadPriceFile().error, /before the one above it/);
});

test('appendSnapshot reloads the file first, so a hand-added snapshot survives the next append', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, snapshots: [
    { effectiveFrom: '2026-10-05', appliedAt: NOW.toISOString(), source: 'hand', rows: [ROW] },
  ] }));
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [{ ...ROW, input: 9, output: 45 }], source: 'test', now: NOW });
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
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-01', rows: [ROW], source: 'test', now: NOW });
  assert.match(result.error, /2026-10-05/);
});

test('appendSnapshot reloads the file first, so a file corrupted after the last load is refused, not overwritten', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', now: NOW });
  assert.match(result.error, /unreadable/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json', 'the file is left for the owner to fix');
});

test('a write that cannot succeed returns an error instead of throwing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-prices-'));
  // Read-only config dir: the file itself is missing (a harmless ENOENT on
  // load), but mkdirSync cannot create cc-dashboard/ to hold it.
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked, { mode: 0o555 });
  useConfigDir(t, locked);
  t.after(() => fs.chmodSync(locked, 0o755));
  store.loadPriceFile();
  const result = store.appendSnapshot({ effectiveFrom: '2026-10-15', rows: [ROW], source: 'test', now: NOW });
  assert.match(result.error, /Could not write/);
});
