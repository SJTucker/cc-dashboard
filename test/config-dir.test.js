'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../lib/config-dir');

const HOME = os.homedir();
const REPO = path.join(__dirname, '..');
const DEFAULTS = {
  configDir: path.join(HOME, '.claude'),
  claudeJsonPath: path.join(HOME, '.claude.json'),
  changesFile: path.join(REPO, 'changes.json'),
  rtkDb: path.join(HOME, 'Library', 'Application Support', 'rtk', 'history.db'),
  port: null,
};

test('an empty env gives the defaults', () => {
  assert.deepStrictEqual(loadConfig({}), DEFAULTS);
});

test('CLAUDE_CONFIG_DIR moves the config dir, and .claude.json into it', () => {
  const config = loadConfig({ CLAUDE_CONFIG_DIR: '/cfg' });
  assert.strictEqual(config.configDir, '/cfg');
  assert.strictEqual(config.claudeJsonPath, path.join('/cfg', '.claude.json'));
});

test('CHANGES_FILE, RTK_DB and PORT are taken as given', () => {
  const config = loadConfig({ CHANGES_FILE: '/x/changes.json', RTK_DB: '/x/history.db', PORT: '3601' });
  assert.strictEqual(config.changesFile, '/x/changes.json');
  assert.strictEqual(config.rtkDb, '/x/history.db');
  assert.strictEqual(config.port, '3601');
});

test('each path variable expands a leading ~', () => {
  const config = loadConfig({ CLAUDE_CONFIG_DIR: '~/cfg', CHANGES_FILE: '~/my-changes.json', RTK_DB: '~/rtk/history.db' });
  assert.strictEqual(config.configDir, path.join(HOME, 'cfg'));
  assert.strictEqual(config.claudeJsonPath, path.join(HOME, 'cfg', '.claude.json'));
  assert.strictEqual(config.changesFile, path.join(HOME, 'my-changes.json'));
  assert.strictEqual(config.rtkDb, path.join(HOME, 'rtk', 'history.db'));
});

test('a path variable set to the empty string counts as unset', () => {
  assert.deepStrictEqual(loadConfig({ CLAUDE_CONFIG_DIR: '', CHANGES_FILE: '', RTK_DB: '' }), DEFAULTS);
});

test('PORT is not validated here, so a bad value cannot stop the bin/ recorders', () => {
  assert.strictEqual(loadConfig({ PORT: 'abc' }).port, 'abc');
});

test('with no argument loadConfig reads process.env', () => {
  assert.deepStrictEqual(loadConfig(), loadConfig(process.env));
});
