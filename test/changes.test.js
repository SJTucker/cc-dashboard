'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

// Both CLAUDE_CONFIG_DIR and CHANGES_FILE are read at call time, so each test sets
// them and requires a fresh copy.
function setup({ plugins, changes } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-changes-'));
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  if (plugins !== undefined) {
    fs.mkdirSync(path.join(base, 'plugins'));
    fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'), typeof plugins === 'string' ? plugins : JSON.stringify(plugins));
  }
  const changesPath = path.join(base, 'changes.json');
  if (changes !== undefined) fs.writeFileSync(changesPath, typeof changes === 'string' ? changes : JSON.stringify(changes));
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.CHANGES_FILE = changesPath;
  delete require.cache[require.resolve('../lib/scan')];
  delete require.cache[require.resolve('../lib/changes')];
  return { changes: require('../lib/changes'), changesPath };
}

test('pluginMarkers reads installedAt from installed_plugins.json', () => {
  const { changes } = setup({
    plugins: { version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user', installedAt: '2026-09-08T14:59:19.000Z' }], 'bad@x': [{ installedAt: 'nope' }] } },
  });
  assert.deepStrictEqual(changes.pluginMarkers(), [
    { t: Date.parse('2026-09-08T14:59:19.000Z'), kind: 'plugin', label: 'ponytail plugin installed', source: 'plugin' },
  ]);
});

test('pluginMarkers returns [] for a missing or malformed file', () => {
  assert.deepStrictEqual(setup().changes.pluginMarkers(), []);
  assert.deepStrictEqual(setup({ plugins: '{not json' }).changes.pluginMarkers(), []);
});

test('modelMarkers skips models already in use when history begins', () => {
  const { changes } = setup();
  const t0 = Date.parse('2026-08-25T12:00:00Z');
  const calls = [
    { t: t0, model: 'claude-opus-5' },
    { t: t0 + DAY / 2, model: 'claude-haiku-4-5' }, // within 24h of the first call
    { t: t0 + 20 * DAY, model: 'claude-opus-5-5' },
    { t: t0 + 21 * DAY, model: 'claude-opus-5-5' },
    { t: t0 + 22 * DAY, model: null },
  ];
  assert.deepStrictEqual(changes.modelMarkers(calls), [
    { t: t0 + 20 * DAY, kind: 'model', label: 'claude-opus-5-5 first used', source: 'model' },
  ]);
});

test('fileMarkers: missing file', () => {
  const { changes, changesPath } = setup();
  assert.deepStrictEqual(changes.fileMarkers(), { markers: [], file: { path: changesPath, status: 'missing' } });
});

test('fileMarkers: malformed JSON and a non-array are errors, not throws', () => {
  let r = setup({ changes: '[{"date": ' }).changes.fileMarkers();
  assert.strictEqual(r.file.status, 'error');
  assert.match(r.file.error, /Not valid JSON/);
  r = setup({ changes: { date: '2026-09-04' } }).changes.fileMarkers();
  assert.strictEqual(r.file.status, 'error');
  assert.match(r.file.error, /JSON array/);
});

test('fileMarkers: local times, unknown kind, bad date skipped and reported', () => {
  const { changes } = setup({
    changes: [
      { date: '2026-09-04T11:15', kind: 'rtk', label: 'rtk config rewritten' },
      { date: '2026-09-15', kind: 'weird', label: 'bare date' },
      { date: 'last tuesday', kind: 'hook', label: 'bad' },
      { date: '2026-09-16T09:00' },
    ],
  });
  const { markers, file } = changes.fileMarkers();
  assert.deepStrictEqual(markers, [
    { t: new Date(2026, 8, 4, 11, 15).getTime(), kind: 'rtk', label: 'rtk config rewritten', source: 'file' },
    { t: new Date(2026, 8, 15).getTime(), kind: 'other', label: 'bare date', source: 'file' },
    { t: new Date(2026, 8, 16, 9).getTime(), kind: 'other', label: '(no label)', source: 'file' },
  ]);
  assert.strictEqual(file.status, 'error');
  assert.match(file.error, /entry 3/);
});

test('collectMarkers merges all sources sorted by time', () => {
  const { changes } = setup({
    plugins: { plugins: { 'figma@x': [{ installedAt: '2026-09-03T15:17:27Z' }] } },
    changes: [{ date: '2026-09-01T09:00', kind: 'skill', label: 'early' }],
  });
  const { markers, changesFile } = changes.collectMarkers([]);
  assert.deepStrictEqual(markers.map((m) => m.source), ['file', 'plugin']);
  assert.strictEqual(changesFile.status, 'ok');
});

test('getChangesPath expands a leading tilde', () => {
  const { changes } = setup();
  process.env.CHANGES_FILE = '~/my-changes.json';
  assert.strictEqual(changes.getChangesPath(), path.join(os.homedir(), 'my-changes.json'));
});
