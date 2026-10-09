'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

// Both CLAUDE_CONFIG_DIR and CHANGES_FILE are read at call time, so each test sets
// them and requires a fresh copy.
function setup({ plugins, changes, updates, auto } = {}) {
  const base = helpers.tmpDir(null, 'changes');
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  if (plugins !== undefined) {
    fs.mkdirSync(path.join(base, 'plugins'));
    fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'), typeof plugins === 'string' ? plugins : JSON.stringify(plugins));
  }
  if (auto !== undefined) {
    const dir = path.join(base, 'cc-dashboard', 'changes');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(auto)) {
      fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  const changesPath = path.join(base, 'changes.json');
  if (changes !== undefined) fs.writeFileSync(changesPath, typeof changes === 'string' ? changes : JSON.stringify(changes));
  if (updates !== undefined) {
    fs.mkdirSync(path.join(base, 'cc-dashboard'), { recursive: true });
    fs.writeFileSync(path.join(base, 'cc-dashboard', 'updates.json'), JSON.stringify(updates));
  }
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.CHANGES_FILE = changesPath;
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
    { t: t0 + 8 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.286: Subagents share the parent cache', version: '2.1.286', summary: 'Subagents share the parent cache', source: 'update' },
  ]);
});

test('updateMarkers labels a relevant verdict without a summary with the version alone', () => {
  const { changes } = setup({
    updates: { '2.1.286': { relevant: true }, '2.1.287': { relevant: true, summary: '' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.280' },
    { t: t0 + 8 * DAY, version: '2.1.286' },
    { t: t0 + 9 * DAY, version: '2.1.287' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls), [
    { t: t0 + 8 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.286', version: '2.1.286', source: 'update' },
    { t: t0 + 9 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.287', version: '2.1.287', source: 'update' },
  ]);
});

test('updateMarkers skips a version first used after a newer one', () => {
  const { changes } = setup({
    updates: { '2.1.290': { relevant: true, summary: 'Newer' }, '2.1.280': { relevant: true, summary: 'Older' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.270' },
    { t: t0 + 8 * DAY, version: '2.1.290' },
    { t: t0 + 10 * DAY, version: '2.1.280' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls).map((m) => m.label), ['Claude Code 2.1.290: Newer']);
});

test('updateMarkers marks consecutive releases first used in version order', () => {
  const { changes } = setup({
    updates: { '2.1.286': { relevant: true, summary: 'A' }, '2.1.287': { relevant: true, summary: 'B' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.270' },
    { t: t0 + 8 * DAY, version: '2.1.286' },
    { t: t0 + 9 * DAY, version: '2.1.287' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls).map((m) => m.label), ['Claude Code 2.1.286: A', 'Claude Code 2.1.287: B']);
});

test('updateMarkers lets a not-relevant newer release block an older relevant one', () => {
  const { changes } = setup({
    updates: { '2.1.291': { relevant: false }, '2.1.288': { relevant: true, summary: 'Older' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.270' },
    { t: t0 + 8 * DAY, version: '2.1.291' },
    { t: t0 + 9 * DAY, version: '2.1.288' },
    { t: t0 + 10 * DAY, version: '2.1.292-dev.1' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls), []);
});

test('updateMarkers returns [] without updates.json', () => {
  const { changes } = setup();
  assert.deepStrictEqual(changes.updateMarkers([{ t: 0, version: '2.1.280' }, { t: 30 * DAY, version: '2.1.286' }]), []);
});

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const CLAUDE = '/home/u/.claude/CLAUDE.md';

test('autoMarkers merges entries for one file, kind and day into one marker', () => {
  const { changes } = setup({
    auto: {
      's1.json': [{ t: at(6, 10), kind: 'claude-md', name: 'CLAUDE.md', label: "don't commit docs", file: CLAUDE }],
      's2.json': [{ t: at(6, 15), kind: 'claude-md', name: 'CLAUDE.md', label: 'use cx for complexity', file: CLAUDE }],
    },
  });
  assert.deepStrictEqual(changes.autoMarkers(), [
    { t: at(6, 15), kind: 'claude-md', label: "CLAUDE.md: don't commit docs; use cx for complexity", source: 'auto' },
  ]);
});

test('autoMarkers merges the same entry from two session files', () => {
  const entry = { t: at(6, 10), kind: 'skill', name: 'skill dataviz', label: 'added', file: '/home/u/.claude/skills/dataviz/SKILL.md' };
  const { changes } = setup({ auto: { 's1.json': [entry], 's2.json': [entry] } });
  assert.deepStrictEqual(changes.autoMarkers(), [{ t: at(6, 10), kind: 'skill', label: 'skill dataviz: added', source: 'auto' }]);
});

test('autoMarkers keeps different days, kinds and files apart', () => {
  const settings = '/home/u/.claude/settings.json';
  const { changes } = setup({
    auto: {
      's1.json': [
        { t: at(6, 10), kind: 'claude-md', name: 'CLAUDE.md', label: 'a', file: CLAUDE },
        { t: at(7, 10), kind: 'claude-md', name: 'CLAUDE.md', label: 'b', file: CLAUDE },
        { t: at(6, 11), kind: 'hook', name: 'settings.json', label: 'hooks.Stop added', file: settings },
        { t: at(6, 11), kind: 'effort', name: 'settings.json', label: 'effortLevel high → medium', file: settings },
      ],
    },
  });
  assert.deepStrictEqual(changes.autoMarkers().map((m) => m.label).sort(), [
    'CLAUDE.md: a',
    'CLAUDE.md: b',
    'settings.json: effortLevel high → medium',
    'settings.json: hooks.Stop added',
  ]);
});

test('autoMarkers skips bad files and bad entries, and maps an unknown kind to other', () => {
  const { changes } = setup({
    auto: {
      'bad.json': '{not json',
      'object.json': { t: 1 },
      'notes.txt': 'ignored',
      's1.json': [
        { kind: 'claude-md', name: 'CLAUDE.md', label: 'no t', file: CLAUDE },
        { t: at(6, 10), kind: 'claude-md', name: 'CLAUDE.md', label: 'no file' },
        { t: at(6, 12), kind: 'agent', name: 'agent x', label: 'changed', file: '/home/u/.claude/agents/x.md' },
      ],
    },
  });
  assert.deepStrictEqual(changes.autoMarkers(), [{ t: at(6, 12), kind: 'other', label: 'agent x: changed', source: 'auto' }]);
});

test('autoMarkers returns [] without the changes folder', () => {
  assert.deepStrictEqual(setup().changes.autoMarkers(), []);
});

test('collectMarkers drops a settings model marker beside a transcript model marker on the same day', () => {
  const settings = '/home/u/.claude/settings.json';
  const { changes } = setup({
    auto: {
      's1.json': [
        { t: at(20, 9), kind: 'model', name: 'settings.json', label: 'model opus → sonnet', file: settings },
        { t: at(25, 9), kind: 'model', name: 'settings.json', label: 'model sonnet → opus', file: settings },
      ],
    },
  });
  const calls = [{ t: at(1, 9), model: 'claude-opus-5' }, { t: at(20, 10), model: 'claude-sonnet-5-5' }];
  const labels = changes.collectMarkers(calls).markers.map((m) => m.label);
  assert.deepStrictEqual(labels, ['claude-sonnet-5-5 first used', 'settings.json: model sonnet → opus']);
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
