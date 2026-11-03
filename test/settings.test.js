'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readSettings, writeSettings, getSettingsPath } = require('../lib/settings');
const helpers = require('./helpers');

const BOTH_ON = { reviews: true, setupLabels: true };

function put(cfg, text) {
  const file = getSettingsPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('readSettings gives both on when the file is missing', (t) => {
  assert.deepStrictEqual(readSettings(helpers.tmpDir(t, 'settings')), BOTH_ON);
});

test('readSettings counts only false as off', (t) => {
  const cfg = helpers.tmpDir(t, 'settings');
  put(cfg, '{"reviews": false, "setupLabels": "no"}');
  assert.deepStrictEqual(readSettings(cfg), { reviews: false, setupLabels: true });
});

test('readSettings gives both on for a file that is not a JSON object', (t) => {
  for (const text of ['', 'nope', '[]', 'null']) {
    const cfg = helpers.tmpDir(t, 'settings');
    put(cfg, text);
    assert.deepStrictEqual(readSettings(cfg), BOTH_ON, JSON.stringify(text));
  }
});

test('writeSettings round-trips and leaves no temp file', (t) => {
  const cfg = helpers.tmpDir(t, 'settings');
  writeSettings(cfg, { reviews: false, setupLabels: true });
  assert.deepStrictEqual(readSettings(cfg), { reviews: false, setupLabels: true });
  assert.deepStrictEqual(fs.readdirSync(path.join(cfg, 'cc-dashboard')), ['settings.json']);
});
