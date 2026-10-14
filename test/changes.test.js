'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const changes = require('../lib/changes');
const { loadConfig } = require('../lib/config-dir');

const DAY = 24 * 60 * 60 * 1000;

// Each test gets a throwaway config folder and passes its paths in.
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
  return { changes, changesPath, base, config: loadConfig({ CLAUDE_CONFIG_DIR: base, CHANGES_FILE: changesPath }) };
}

test('pluginMarkers reads installedAt from installed_plugins.json', () => {
  const { base } = setup({
    plugins: { version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user', installedAt: '2026-09-08T14:59:19.000Z' }], 'bad@x': [{ installedAt: 'nope' }] } },
  });
  assert.deepStrictEqual(changes.pluginMarkers(base), [
    { t: Date.parse('2026-09-08T14:59:19.000Z'), kind: 'plugin', label: 'ponytail plugin installed', source: 'plugin' },
  ]);
});

test('pluginMarkers labels a non-user-scope install with its scope and project', () => {
  const { base } = setup({
    plugins: {
      plugins: {
        'typescript-lsp@claude-plugins-official': [
          { scope: 'project', projectPath: '/Users/me/code/my-project', installedAt: '2026-09-28T16:02:37.361Z' },
          { scope: 'user', installedAt: '2026-09-28T16:04:14.225Z' },
        ],
      },
    },
  });
  assert.deepStrictEqual(changes.pluginMarkers(base), [
    { t: Date.parse('2026-09-28T16:02:37.361Z'), kind: 'plugin', label: 'typescript-lsp plugin installed (project my-project)', source: 'plugin' },
    { t: Date.parse('2026-09-28T16:04:14.225Z'), kind: 'plugin', label: 'typescript-lsp plugin installed', source: 'plugin' },
  ]);
});

test('pluginMarkers returns [] for a missing or malformed file', () => {
  assert.deepStrictEqual(changes.pluginMarkers(setup().base), []);
  assert.deepStrictEqual(changes.pluginMarkers(setup({ plugins: '{not json' }).base), []);
});

test('modelMarkers skips models within a 7-day before-window of the earliest call', () => {
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
  const { changesPath } = setup();
  assert.deepStrictEqual(changes.fileMarkers(changesPath), { markers: [], file: { path: changesPath, status: 'missing' } });
});

test('fileMarkers: malformed JSON and a non-array are errors, not throws', () => {
  let r = changes.fileMarkers(setup({ changes: '[{"date": ' }).changesPath);
  assert.strictEqual(r.file.status, 'error');
  assert.match(r.file.error, /Not valid JSON/);
  r = changes.fileMarkers(setup({ changes: { date: '2026-09-04' } }).changesPath);
  assert.strictEqual(r.file.status, 'error');
  assert.match(r.file.error, /JSON array/);
});

test('fileMarkers: local times, unknown kind, bad date skipped and reported', () => {
  const { changesPath } = setup({
    changes: [
      { date: '2026-09-04T11:15', kind: 'rtk', label: 'rtk config rewritten' },
      { date: '2026-09-15', kind: 'weird', label: 'bare date' },
      { date: 'last tuesday', kind: 'hook', label: 'bad' },
      { date: '2026-09-16T09:00' },
    ],
  });
  const { markers, file } = changes.fileMarkers(changesPath);
  assert.deepStrictEqual(markers, [
    { t: new Date(2026, 8, 4, 11, 15).getTime(), kind: 'rtk', label: 'rtk config rewritten', source: 'file' },
    { t: new Date(2026, 8, 15).getTime(), kind: 'other', label: 'bare date', source: 'file' },
    { t: new Date(2026, 8, 16, 9).getTime(), kind: 'other', label: '(no label)', source: 'file' },
  ]);
  assert.strictEqual(file.status, 'error');
  assert.match(file.error, /entry 3/);
});

test('updateMarkers marks relevant versions at their first call, after a week of history', () => {
  const { base } = setup({
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
  assert.deepStrictEqual(changes.updateMarkers(calls, path.join(base, 'cc-dashboard', 'updates.json')), [
    { t: t0 + 8 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.286: Subagents share the parent cache', version: '2.1.286', summary: 'Subagents share the parent cache', source: 'update' },
  ]);
});

test('updateMarkers labels a relevant verdict without a summary with the version alone', () => {
  const { base } = setup({
    updates: { '2.1.286': { relevant: true }, '2.1.287': { relevant: true, summary: '' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.280' },
    { t: t0 + 8 * DAY, version: '2.1.286' },
    { t: t0 + 9 * DAY, version: '2.1.287' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls, path.join(base, 'cc-dashboard', 'updates.json')), [
    { t: t0 + 8 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.286', version: '2.1.286', source: 'update' },
    { t: t0 + 9 * DAY, kind: 'claude-code', label: 'Claude Code 2.1.287', version: '2.1.287', source: 'update' },
  ]);
});

test('updateMarkers skips a version first used after a newer one', () => {
  const { base } = setup({
    updates: { '2.1.290': { relevant: true, summary: 'Newer' }, '2.1.280': { relevant: true, summary: 'Older' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.270' },
    { t: t0 + 8 * DAY, version: '2.1.290' },
    { t: t0 + 10 * DAY, version: '2.1.280' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls, path.join(base, 'cc-dashboard', 'updates.json')).map((m) => m.label), ['Claude Code 2.1.290: Newer']);
});

test('updateMarkers marks consecutive releases first used in version order', () => {
  const { base } = setup({
    updates: { '2.1.286': { relevant: true, summary: 'A' }, '2.1.287': { relevant: true, summary: 'B' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.270' },
    { t: t0 + 8 * DAY, version: '2.1.286' },
    { t: t0 + 9 * DAY, version: '2.1.287' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls, path.join(base, 'cc-dashboard', 'updates.json')).map((m) => m.label), ['Claude Code 2.1.286: A', 'Claude Code 2.1.287: B']);
});

test('updateMarkers lets a not-relevant newer release block an older relevant one', () => {
  const { base } = setup({
    updates: { '2.1.291': { relevant: false }, '2.1.288': { relevant: true, summary: 'Older' } },
  });
  const t0 = new Date(2026, 8, 1).getTime();
  const calls = [
    { t: t0, version: '2.1.270' },
    { t: t0 + 8 * DAY, version: '2.1.291' },
    { t: t0 + 9 * DAY, version: '2.1.288' },
    { t: t0 + 10 * DAY, version: '2.1.292-dev.1' },
  ];
  assert.deepStrictEqual(changes.updateMarkers(calls, path.join(base, 'cc-dashboard', 'updates.json')), []);
});

test('updateMarkers returns [] without updates.json', () => {
  const { base } = setup();
  assert.deepStrictEqual(changes.updateMarkers([{ t: 0, version: '2.1.280' }, { t: 30 * DAY, version: '2.1.286' }], path.join(base, 'cc-dashboard', 'updates.json')), []);
});

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const CLAUDE = '/home/u/.claude/CLAUDE.md';

test('autoMarkers merges entries for one file, kind and day into one marker', () => {
  const { base } = setup({
    auto: {
      's1.json': [{ t: at(6, 10), kind: 'claude-md', name: 'CLAUDE.md', label: "don't commit docs", file: CLAUDE }],
      's2.json': [{ t: at(6, 15), kind: 'claude-md', name: 'CLAUDE.md', label: 'use cx for complexity', file: CLAUDE }],
    },
  });
  assert.deepStrictEqual(changes.autoMarkers(base), [
    { t: at(6, 15), kind: 'claude-md', label: "CLAUDE.md: don't commit docs; use cx for complexity", source: 'auto' },
  ]);
});

test('autoMarkers merges the same entry from two session files', () => {
  const entry = { t: at(6, 10), kind: 'skill', name: 'skill dataviz', label: 'added', file: '/home/u/.claude/skills/dataviz/SKILL.md' };
  const { base } = setup({ auto: { 's1.json': [entry], 's2.json': [entry] } });
  assert.deepStrictEqual(changes.autoMarkers(base), [{ t: at(6, 10), kind: 'skill', label: 'skill dataviz: added', source: 'auto' }]);
});

test('autoMarkers keeps different days, kinds and files apart', () => {
  const settings = '/home/u/.claude/settings.json';
  const { base } = setup({
    auto: {
      's1.json': [
        { t: at(6, 10), kind: 'claude-md', name: 'CLAUDE.md', label: 'a', file: CLAUDE },
        { t: at(7, 10), kind: 'claude-md', name: 'CLAUDE.md', label: 'b', file: CLAUDE },
        { t: at(6, 11), kind: 'hook', name: 'settings.json', label: 'hooks.Stop added', file: settings },
        { t: at(6, 11), kind: 'effort', name: 'settings.json', label: 'effortLevel high → medium', file: settings },
      ],
    },
  });
  assert.deepStrictEqual(changes.autoMarkers(base).map((m) => m.label).sort(), [
    'CLAUDE.md: a',
    'CLAUDE.md: b',
    'settings.json: effortLevel high → medium',
    'settings.json: hooks.Stop added',
  ]);
});

test('autoMarkers skips bad files and bad entries, and maps an unknown kind to other', () => {
  const { base } = setup({
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
  assert.deepStrictEqual(changes.autoMarkers(base), [{ t: at(6, 12), kind: 'other', label: 'agent x: changed', source: 'auto' }]);
});

test('autoMarkers returns [] without the changes folder', () => {
  assert.deepStrictEqual(changes.autoMarkers(setup().base), []);
});

test('collectMarkers drops a settings model marker beside a transcript model marker on the same day', () => {
  const settings = '/home/u/.claude/settings.json';
  const { config } = setup({
    auto: {
      's1.json': [
        { t: at(20, 9), kind: 'model', name: 'settings.json', label: 'model opus → sonnet', file: settings },
        { t: at(25, 9), kind: 'model', name: 'settings.json', label: 'model sonnet → opus', file: settings },
      ],
    },
  });
  const calls = [{ t: at(1, 9), model: 'claude-opus-5' }, { t: at(20, 10), model: 'claude-sonnet-5-5' }];
  const labels = changes.collectMarkers(calls, config).markers.map((m) => m.label);
  assert.deepStrictEqual(labels, ['claude-sonnet-5-5 first used', 'settings.json: model sonnet → opus']);
});

test('collectMarkers merges all sources sorted by time', () => {
  const { config } = setup({
    plugins: { plugins: { 'figma@x': [{ installedAt: '2026-09-03T15:17:27Z' }] } },
    changes: [{ date: '2026-09-01T09:00', kind: 'skill', label: 'early' }],
    updates: { '2.1.286': { relevant: true, summary: 'Cache shared' } },
  });
  const t0 = new Date(2026, 7, 20).getTime();
  const calls = [{ t: t0, version: '2.1.280' }, { t: new Date(2026, 8, 5).getTime(), version: '2.1.286' }];
  const { markers, changesFile } = changes.collectMarkers(calls, config);
  assert.deepStrictEqual(markers.map((m) => m.source), ['file', 'plugin', 'update']);
  assert.strictEqual(changesFile.status, 'ok');
});

test('collectMarkers drops a plugin, file and auto marker in the first week of history and keeps one after it', () => {
  const t0 = new Date(2026, 8, 1, 9).getTime();
  const iso = (t) => new Date(t).toISOString();
  const settings = '/home/u/.claude/settings.json';
  const { config } = setup({
    plugins: { plugins: { 'early@x': [{ installedAt: iso(t0 + 2.5 * DAY) }], 'late@x': [{ installedAt: iso(t0 + 8 * DAY) }] } },
    changes: [{ date: iso(t0 + 2.5 * DAY), kind: 'skill', label: 'early file' }, { date: iso(t0 + 8 * DAY), kind: 'skill', label: 'late file' }],
    auto: {
      's1.json': [
        { t: t0 + 2.5 * DAY, kind: 'skill', name: 'a.md', label: 'early auto', file: settings },
        { t: t0 + 8 * DAY, kind: 'skill', name: 'b.md', label: 'late auto', file: settings },
      ],
    },
  });
  const calls = [{ t: t0 }, { t: t0 + 10 * DAY }];
  const labels = changes.collectMarkers(calls, config).markers.map((m) => m.label);
  assert.deepStrictEqual(labels.sort(), ['b.md: late auto', 'late file', 'late plugin installed']);
});
