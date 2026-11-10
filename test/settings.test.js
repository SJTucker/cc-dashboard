'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readSettings, writeSettings, getSettingsPath, validSettingValue } = require('../lib/settings');
const helpers = require('./helpers');

const DEFAULTS = { handoff: 'document', transcriptIndex: true, reviews: true, setupMarkers: true, setupLabels: true, activity: true, limitBand: true };

function put(cfg, text) {
  const file = getSettingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('readSettings defaults every key', (t) => {
  assert.deepStrictEqual(readSettings(helpers.tmpDir(t, 'settings')), DEFAULTS);
});

test('readSettings reads an unknown handoff value as document', (t) => {
  for (const text of ['{"handoff":"fork"}', '{"handoff":7}']) {
    const cfg = helpers.tmpDir(t, 'settings');
    put(cfg, text);
    assert.strictEqual(readSettings(cfg).handoff, 'document', text);
  }
  const cfg = helpers.tmpDir(t, 'settings');
  put(cfg, '{"handoff":"off"}');
  assert.strictEqual(readSettings(cfg).handoff, 'off');
});

test('readSettings turns a key off only for literal false', (t) => {
  const cfg = helpers.tmpDir(t, 'settings');
  put(cfg, '{"activity": 0, "limitBand": false, "reviews": "no"}');
  assert.deepStrictEqual(readSettings(cfg), { ...DEFAULTS, limitBand: false });
});

test('readSettings gives every default for a file that is not a JSON object', (t) => {
  for (const text of ['', 'nope', '[]', 'null']) {
    const cfg = helpers.tmpDir(t, 'settings');
    put(cfg, text);
    assert.deepStrictEqual(readSettings(cfg), DEFAULTS, JSON.stringify(text));
  }
});

test('validSettingValue accepts only the spec values', () => {
  assert.ok(validSettingValue('reviews', false));
  assert.ok(!validSettingValue('reviews', 'no'));
  assert.ok(validSettingValue('handoff', 'transcript'));
  assert.ok(!validSettingValue('handoff', 'fork'));
  assert.ok(!validSettingValue('nope', true));
});

test('writeSettings round-trips and leaves no temp file', (t) => {
  const cfg = helpers.tmpDir(t, 'settings');
  const next = { ...DEFAULTS, reviews: false, handoff: 'off' };
  writeSettings(cfg, next);
  assert.deepStrictEqual(readSettings(cfg), next);
  assert.deepStrictEqual(fs.readdirSync(path.join(cfg, 'cc-dashboard')), ['settings.json']);
});

test('writeSettings keeps unknown keys', (t) => {
  const cfg = helpers.tmpDir(t, 'settings');
  put(cfg, '{"future": 1, "reviews": false}');
  writeSettings(cfg, DEFAULTS);
  const saved = JSON.parse(fs.readFileSync(getSettingsPath(cfg), 'utf8'));
  assert.strictEqual(saved.future, 1);
  assert.strictEqual(saved.reviews, true);
});

// The mod keeps its own parse in mod/hooks/setup.ts. Its fixtures match
// test/mod-contract.test.js and 'parseDashboardSettings matches the server fixtures' in mod/hooks/setup.test.ts.
