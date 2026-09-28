'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getClaudeJsonPath, getRateLimitsPath, recordRateLimits, readLimits } = require('../lib/limits');

const NOW = Date.parse('2026-09-28T17:55:00Z');
const FETCHED = NOW - 3 * 60 * 1000;

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-limits-'));
  return path.join(dir, name);
}

function writeClaudeJson(content) {
  const file = tmpFile('.claude.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function writeRateLimits(content) {
  const file = tmpFile('rate-limits.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

// A path in a directory that exists but holds no file at that name, so a read
// of it fails the same way a first-ever run (no cache written yet) would.
function missingFile(name) {
  return tmpFile(name);
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
  const claudeJson = writeClaudeJson(withCache({
    five_hour: usageWindow(6, '2026-09-28T22:20:00.233620+00:00'),
    seven_day: usageWindow(7, '2026-10-04T10:00:00.233643+00:00'),
    seven_day_opus: null,
    nimbus_quill: usageWindow(0, null),
  }));
  const rateLimits = missingFile('rate-limits.json');
  assert.deepStrictEqual(readLimits({ claudeJson, rateLimits, now: NOW }), {
    fetchedAt: FETCHED,
    limits: [
      { key: 'five_hour', label: 'Current session', percent: 6, resetsAt: Date.parse('2026-09-28T22:20:00.233620+00:00') },
      { key: 'seven_day', label: 'Current week (all models)', percent: 7, resetsAt: Date.parse('2026-10-04T10:00:00.233643+00:00') },
    ],
    source: 'usage-cache',
  });
});

test('readLimits drops a window whose reset time has passed', () => {
  const claudeJson = writeClaudeJson(withCache({
    five_hour: usageWindow(80, '2026-09-28T17:00:00Z'), // before NOW
    seven_day: usageWindow(7, '2026-10-04T10:00:00Z'),
  }));
  const rateLimits = missingFile('rate-limits.json');
  assert.deepStrictEqual(readLimits({ claudeJson, rateLimits, now: NOW }).limits.map((l) => l.key), ['seven_day']);
});

test('readLimits keeps a window with no reset time, and skips one with no number', () => {
  const claudeJson = writeClaudeJson(withCache({
    five_hour: usageWindow(0, null),
    seven_day: { utilization: 'lots', resets_at: '2026-10-04T10:00:00Z' },
  }));
  const rateLimits = missingFile('rate-limits.json');
  assert.deepStrictEqual(readLimits({ claudeJson, rateLimits, now: NOW }).limits, [
    { key: 'five_hour', label: 'Current session', percent: 0, resetsAt: null },
  ]);
});

test('readLimits returns null for a missing file, missing key or bad JSON', () => {
  const rateLimits = missingFile('rate-limits.json');
  assert.strictEqual(readLimits({ claudeJson: missingFile('.claude.json'), rateLimits, now: NOW }), null);
  assert.strictEqual(readLimits({ claudeJson: writeClaudeJson('{"cachedUsage'), rateLimits, now: NOW }), null);
  assert.strictEqual(readLimits({ claudeJson: writeClaudeJson({ oauthAccount: {} }), rateLimits, now: NOW }), null);
  assert.strictEqual(
    readLimits({ claudeJson: writeClaudeJson({ cachedUsageUtilization: { utilization: {} } }), rateLimits, now: NOW }),
    null,
    'no fetchedAtMs',
  );
  assert.strictEqual(
    readLimits({ claudeJson: writeClaudeJson(withCache({ seven_day_opus: null })), rateLimits, now: NOW }),
    null,
    'neither window present',
  );
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

test('getRateLimitsPath: RATE_LIMITS_JSON, then CLAUDE_CONFIG_DIR, then the home directory', () => {
  const saved = { json: process.env.RATE_LIMITS_JSON, dir: process.env.CLAUDE_CONFIG_DIR };
  try {
    delete process.env.RATE_LIMITS_JSON;
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.strictEqual(getRateLimitsPath(), path.join(os.homedir(), '.claude', 'rate-limits.json'));
    process.env.CLAUDE_CONFIG_DIR = '~/alt-claude';
    assert.strictEqual(getRateLimitsPath(), path.join(os.homedir(), 'alt-claude', 'rate-limits.json'));
    process.env.RATE_LIMITS_JSON = '~/elsewhere/rate-limits.json';
    assert.strictEqual(getRateLimitsPath(), path.join(os.homedir(), 'elsewhere', 'rate-limits.json'));
  } finally {
    for (const [key, name] of [['json', 'RATE_LIMITS_JSON'], ['dir', 'CLAUDE_CONFIG_DIR']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
});

function statuslineInput(overrides = {}) {
  return {
    transcript_path: overrides.transcript_path,
    rate_limits: overrides.rate_limits !== undefined ? overrides.rate_limits : {
      five_hour: { used_percentage: 12.5, resets_at: Math.floor(NOW / 1000) + 2 * 60 * 60 },
    },
    session_id: 'super-secret-session-id-should-not-be-written',
  };
}

function makeTranscript(mtimeMs) {
  const file = tmpFile('session.jsonl');
  fs.writeFileSync(file, '{}\n');
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('recordRateLimits writes a fresh file stamped with the transcript mtime', () => {
  const transcript = makeTranscript(FETCHED);
  const file = missingFile('rate-limits.json');
  recordRateLimits(statuslineInput({ transcript_path: transcript }), file);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.fetchedAtMs, FETCHED);
  assert.deepStrictEqual(written.rate_limits, {
    five_hour: { used_percentage: 12.5, resets_at: Math.floor(NOW / 1000) + 2 * 60 * 60 },
  });
});

test('recordRateLimits writes only rate_limits, nothing else from the statusline input', () => {
  const transcript = makeTranscript(FETCHED);
  const file = missingFile('rate-limits.json');
  recordRateLimits(statuslineInput({ transcript_path: transcript }), file);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('super-secret-session-id-should-not-be-written'));
  assert.deepStrictEqual(Object.keys(JSON.parse(raw)).sort(), ['fetchedAtMs', 'rate_limits']);
});

test('recordRateLimits skips the write when the existing stamp is newer', () => {
  const file = writeRateLimits({ fetchedAtMs: FETCHED + 60_000, rate_limits: { five_hour: { used_percentage: 1, resets_at: null } } });
  const transcript = makeTranscript(FETCHED);
  recordRateLimits(statuslineInput({ transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 99, resets_at: null } } }), file);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.fetchedAtMs, FETCHED + 60_000);
  assert.strictEqual(written.rate_limits.five_hour.used_percentage, 1);
});

test('recordRateLimits overwrites when the existing stamp is older', () => {
  const file = writeRateLimits({ fetchedAtMs: FETCHED - 60_000, rate_limits: { five_hour: { used_percentage: 1, resets_at: null } } });
  const transcript = makeTranscript(FETCHED);
  recordRateLimits(statuslineInput({ transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 99, resets_at: null } } }), file);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.fetchedAtMs, FETCHED);
  assert.strictEqual(written.rate_limits.five_hour.used_percentage, 99);
});

test('recordRateLimits ignores input with no rate_limits, or an unreadable transcript', () => {
  const file = missingFile('rate-limits.json');
  recordRateLimits({ transcript_path: makeTranscript(FETCHED) }, file);
  assert.strictEqual(fs.existsSync(file), false);
  recordRateLimits(statuslineInput({ transcript_path: path.join(os.tmpdir(), 'no-such-transcript.jsonl') }), file);
  assert.strictEqual(fs.existsSync(file), false);
  recordRateLimits(null, file);
  assert.strictEqual(fs.existsSync(file), false);
});

test('readLimits picks the statusline source when it is newer', () => {
  const claudeJson = writeClaudeJson(withCache({ five_hour: usageWindow(6, null) }, FETCHED - 60_000));
  const rateLimits = writeRateLimits({
    fetchedAtMs: FETCHED,
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: Math.floor(NOW / 1000) + 2 * 60 * 60 } },
  });
  const result = readLimits({ claudeJson, rateLimits, now: NOW });
  assert.strictEqual(result.source, 'statusline');
  assert.strictEqual(result.fetchedAt, FETCHED);
  assert.deepStrictEqual(result.limits, [
    { key: 'five_hour', label: 'Current session', percent: 12.5, resetsAt: (Math.floor(NOW / 1000) + 2 * 60 * 60) * 1000 },
  ]);
});

test('readLimits picks the usage-cache source when it is newer', () => {
  const claudeJson = writeClaudeJson(withCache({ five_hour: usageWindow(6, null) }, FETCHED));
  const rateLimits = writeRateLimits({
    fetchedAtMs: FETCHED - 60_000,
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: null } },
  });
  const result = readLimits({ claudeJson, rateLimits, now: NOW });
  assert.strictEqual(result.source, 'usage-cache');
  assert.strictEqual(result.fetchedAt, FETCHED);
});

test('readLimits converts the statusline source\'s epoch-seconds resets_at to milliseconds', () => {
  const claudeJson = missingFile('.claude.json');
  const resetsAtSeconds = Math.floor(NOW / 1000) + 3600;
  const rateLimits = writeRateLimits({
    fetchedAtMs: FETCHED,
    rate_limits: { seven_day: { used_percentage: 40, resets_at: resetsAtSeconds } },
  });
  const result = readLimits({ claudeJson, rateLimits, now: NOW });
  assert.strictEqual(result.source, 'statusline');
  assert.strictEqual(result.limits[0].resetsAt, resetsAtSeconds * 1000);
});

test('readLimits drops a statusline window whose reset time has passed', () => {
  const claudeJson = missingFile('.claude.json');
  const rateLimits = writeRateLimits({
    fetchedAtMs: FETCHED,
    rate_limits: {
      five_hour: { used_percentage: 80, resets_at: Math.floor(NOW / 1000) - 3600 }, // already past
      seven_day: { used_percentage: 40, resets_at: Math.floor(NOW / 1000) + 3600 },
    },
  });
  const result = readLimits({ claudeJson, rateLimits, now: NOW });
  assert.deepStrictEqual(result.limits.map((l) => l.key), ['seven_day']);
});

test('readLimits falls back to the usage cache when the rate-limits file is malformed', () => {
  const claudeJson = writeClaudeJson(withCache({ five_hour: usageWindow(6, null) }, FETCHED));
  const rateLimits = writeRateLimits('{not json');
  const result = readLimits({ claudeJson, rateLimits, now: NOW });
  assert.strictEqual(result.source, 'usage-cache');
  assert.strictEqual(result.fetchedAt, FETCHED);
});

test('bin/record-limits exits 0 with no output on bad JSON', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'record-limits')], {
    input: 'not json at all',
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
});

test('bin/record-limits writes RATE_LIMITS_JSON with valid input', () => {
  const transcript = makeTranscript(FETCHED);
  const file = missingFile('rate-limits.json');
  const input = JSON.stringify({
    transcript_path: transcript,
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: Math.floor(NOW / 1000) + 3600 } },
  });
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'record-limits')], {
    input,
    encoding: 'utf8',
    env: { ...process.env, RATE_LIMITS_JSON: file },
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.fetchedAtMs, FETCHED);
  assert.strictEqual(written.rate_limits.five_hour.used_percentage, 12.5);
});
