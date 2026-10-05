'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

// Both CLAUDE_CONFIG_DIR and CHANGES_FILE are read at call time, so each test sets
// them and requires a fresh copy.
function setup({ plugins, changes, updates } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-changes-'));
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  if (plugins !== undefined) {
    fs.mkdirSync(path.join(base, 'plugins'));
    fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'), typeof plugins === 'string' ? plugins : JSON.stringify(plugins));
  }
  const changesPath = path.join(base, 'changes.json');
  if (changes !== undefined) fs.writeFileSync(changesPath, typeof changes === 'string' ? changes : JSON.stringify(changes));
  const updatesPath = path.join(base, 'updates.json');
  if (updates !== undefined) fs.writeFileSync(updatesPath, JSON.stringify(updates));
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.CHANGES_FILE = changesPath;
  process.env.UPDATES_FILE = updatesPath;
  delete require.cache[require.resolve('../lib/scan')];
  delete require.cache[require.resolve('../lib/updates')];
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

test('pluginMarkers labels a non-user-scope install with its scope and project', () => {
  const { changes } = setup({
    plugins: {
      plugins: {
        'typescript-lsp@claude-plugins-official': [
          { scope: 'project', projectPath: '/Users/me/code/my-project', installedAt: '2026-09-28T16:02:37.361Z' },
          { scope: 'user', installedAt: '2026-09-28T16:04:14.225Z' },
        ],
      },
    },
  });
  assert.deepStrictEqual(changes.pluginMarkers(), [
    { t: Date.parse('2026-09-28T16:02:37.361Z'), kind: 'plugin', label: 'typescript-lsp plugin installed (project my-project)', source: 'plugin' },
    { t: Date.parse('2026-09-28T16:04:14.225Z'), kind: 'plugin', label: 'typescript-lsp plugin installed', source: 'plugin' },
  ]);
});

test('pluginMarkers returns [] for a missing or malformed file', () => {
  assert.deepStrictEqual(setup().changes.pluginMarkers(), []);
  assert.deepStrictEqual(setup({ plugins: '{not json' }).changes.pluginMarkers(), []);
});

test('modelMarkers skips models within a 7-day before-window of the earliest call', () => {
  const { changes } = setup();
  const t0 = Date.parse('2026-08-25T12:00:00Z');
  const calls = [
    { t: t0, model: 'claude-opus-5' },
    { t: t0 + 3 * DAY, model: 'claude-haiku-4-5' }, // within the 7-day before-window
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

test('updateMarkers marks relevant versions at their first call, after a week of history', () => {
  const { changes } = setup({
    updates: {
      '2.1.280': { relevant: true, summary: 'Running when history starts' },
      '2.1.286': { relevant: true, summary: 'Subagents share the parent cache' },
      '2.1.287': { relevant: false },
      '2.1.288': { relevant: true, summary: 'Never used here' },
    },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.280' },
    { t: t0 + 9 * DAY, version: '2.1.286' },
    { t: t0 + 8 * DAY, version: '2.1.286' },
    { t: t0 + 10 * DAY, version: '2.1.287' },
    { t: t0 + 11 * DAY, version: null },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls), [
    { t: t0 + 8 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.286: Subagents share the parent cache', source: 'update' },
  ]);
});

test('updateMarkers returns [] without updates.json', () => {
  const { changes } = setup();
  assert.deepStrictEqual(changes.updateMarkers([{ t: 0, version: '2.1.280' }, { t: 30 * DAY, version: '2.1.286' }]), []);
});

test('collectMarkers merges all sources sorted by time', () => {
  const { changes } = setup({
    plugins: { plugins: { 'figma@x': [{ installedAt: '2026-09-03T15:17:27Z' }] } },
    changes: [{ date: '2026-09-01T09:00', kind: 'skill', label: 'early' }],
    updates: { '2.1.286': { relevant: true, summary: 'Cache shared' } },
  });
  const t0 = new Date(2026, 7, 20).getTime();
  const calls = [{ t: t0, version: '2.1.280' }, { t: new Date(2026, 8, 5).getTime(), version: '2.1.286' }];
  const { markers, changesFile } = changes.collectMarkers(calls);
  assert.deepStrictEqual(markers.map((m) => m.source), ['file', 'plugin', 'update']);
  assert.strictEqual(changesFile.status, 'ok');
});

test('getChangesPath expands a leading tilde', () => {
  const { changes } = setup();
  process.env.CHANGES_FILE = '~/my-changes.json';
  assert.strictEqual(changes.getChangesPath(), path.join(os.homedir(), 'my-changes.json'));
});
