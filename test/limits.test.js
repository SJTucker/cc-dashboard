'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getClaudeJsonPath, readLimits } = require('../lib/limits');

const NOW = Date.parse('2026-09-28T17:55:00Z');
const FETCHED = NOW - 3 * 60 * 1000;

function writeClaudeJson(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-limits-'));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

// The real file also carries account details; the fixture does too, so a test
// fails if any of it leaks into the result.
function withCache(utilization, fetchedAtMs = FETCHED) {
  return {
    oauthAccount: { emailAddress: 'someone@example.com' },
    cachedUsageUtilization: { fetchedAtMs, accountUuid: 'acct-1', utilization },
  };
}

const usageWindow = (utilization, resets_at) => ({
  utilization, resets_at, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null,
});

test('readLimits returns the session and weekly windows with /usage labels', () => {
  const file = writeClaudeJson(withCache({
    five_hour: usageWindow(6, '2026-09-28T22:20:00.233620+00:00'),
    seven_day: usageWindow(7, '2026-10-04T10:00:00.233643+00:00'),
    seven_day_opus: null,
    nimbus_quill: usageWindow(0, null),
  }));
  assert.deepStrictEqual(readLimits(file, NOW), {
    fetchedAt: FETCHED,
    limits: [
      { key: 'five_hour', label: 'Current session', percent: 6, resetsAt: Date.parse('2026-09-28T22:20:00.233620+00:00') },
      { key: 'seven_day', label: 'Current week (all models)', percent: 7, resetsAt: Date.parse('2026-10-04T10:00:00.233643+00:00') },
    ],
  });
});

test('readLimits drops a window whose reset time has passed', () => {
  const file = writeClaudeJson(withCache({
    five_hour: usageWindow(80, '2026-09-28T17:00:00Z'), // before NOW
    seven_day: usageWindow(7, '2026-10-04T10:00:00Z'),
  }));
  assert.deepStrictEqual(readLimits(file, NOW).limits.map((l) => l.key), ['seven_day']);
});

test('readLimits keeps a window with no reset time, and skips one with no number', () => {
  const file = writeClaudeJson(withCache({
    five_hour: usageWindow(0, null),
    seven_day: { utilization: 'lots', resets_at: '2026-10-04T10:00:00Z' },
  }));
  assert.deepStrictEqual(readLimits(file, NOW).limits, [
    { key: 'five_hour', label: 'Current session', percent: 0, resetsAt: null },
  ]);
});

test('readLimits returns null for a missing file, missing key or bad JSON', () => {
  assert.strictEqual(readLimits(path.join(os.tmpdir(), 'no-such-claude.json'), NOW), null);
  assert.strictEqual(readLimits(writeClaudeJson('{"cachedUsage'), NOW), null);
  assert.strictEqual(readLimits(writeClaudeJson({ oauthAccount: {} }), NOW), null);
  assert.strictEqual(readLimits(writeClaudeJson({ cachedUsageUtilization: { utilization: {} } }), NOW), null, 'no fetchedAtMs');
  assert.strictEqual(readLimits(writeClaudeJson(withCache({ seven_day_opus: null })), NOW), null, 'neither window present');
});

test('getClaudeJsonPath: CLAUDE_JSON, then CLAUDE_CONFIG_DIR, then the home directory', () => {
  const saved = { json: process.env.CLAUDE_JSON, dir: process.env.CLAUDE_CONFIG_DIR };
  try {
    delete process.env.CLAUDE_JSON;
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.strictEqual(getClaudeJsonPath(), path.join(os.homedir(), '.claude.json'));
    process.env.CLAUDE_CONFIG_DIR = '~/alt-claude';
    assert.strictEqual(getClaudeJsonPath(), path.join(os.homedir(), 'alt-claude', '.claude.json'));
    process.env.CLAUDE_JSON = '~/elsewhere/.claude.json';
    assert.strictEqual(getClaudeJsonPath(), path.join(os.homedir(), 'elsewhere', '.claude.json'));
  } finally {
    for (const [key, name] of [['json', 'CLAUDE_JSON'], ['dir', 'CLAUDE_CONFIG_DIR']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});
