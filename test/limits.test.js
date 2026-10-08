'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getClaudeJsonPath, getRateLimitsPath, recordRateLimits, readLimits, readDailyShare } = require('../lib/limits');

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

test('getClaudeJsonPath: inside CLAUDE_CONFIG_DIR, else the home directory', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.strictEqual(getClaudeJsonPath(), path.join(os.homedir(), '.claude.json'));
    process.env.CLAUDE_CONFIG_DIR = '~/alt-claude';
    assert.strictEqual(getClaudeJsonPath(), path.join(os.homedir(), 'alt-claude', '.claude.json'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('getRateLimitsPath: inside CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.strictEqual(getRateLimitsPath(), path.join(os.homedir(), '.claude', 'rate-limits.json'));
    process.env.CLAUDE_CONFIG_DIR = '~/alt-claude';
    assert.strictEqual(getRateLimitsPath(), path.join(os.homedir(), 'alt-claude', 'rate-limits.json'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
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

test('bin/record-limits writes rate-limits.json under CLAUDE_CONFIG_DIR with valid input', () => {
  const transcript = makeTranscript(FETCHED);
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-limits-cfg-'));
  const file = path.join(config, 'rate-limits.json');
  const input = JSON.stringify({
    transcript_path: transcript,
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: Math.floor(NOW / 1000) + 3600 } },
  });
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'record-limits')], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.stderr, '');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.fetchedAtMs, FETCHED);
  assert.strictEqual(written.rate_limits.five_hour.used_percentage, 12.5);
});

// Local wall-clock times, so the tests hold in any timezone.
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const RESET = at(2026, 10, 4, 5); // Sunday 2026-10-04 05:00 local

function weekInput(transcriptMs, percent, resetsAtMs = RESET) {
  return statuslineInput({
    transcript_path: makeTranscript(transcriptMs),
    rate_limits: { seven_day: { used_percentage: percent, resets_at: Math.floor(resetsAtMs / 1000) } },
  });
}

function weekFile(fetchedAtMs, percent, dayStart, resetsAtMs = RESET) {
  const content = { fetchedAtMs, rate_limits: { seven_day: { used_percentage: percent, resets_at: Math.floor(resetsAtMs / 1000) } } };
  if (dayStart) content.dayStart = dayStart;
  return writeRateLimits(content);
}

const readBack = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the first reading ever starts the day at its own weekly percent', () => {
  const file = missingFile('rate-limits.json');
  recordRateLimits(weekInput(at(2026, 9, 30, 9), 13), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 13, from: 'first-reading' });
});

test('the first reading of a new day starts the day at the previous reading', () => {
  const file = weekFile(at(2026, 9, 29, 18), 12, { date: '2026-09-29', percent: 9, from: 'previous-reading' });
  recordRateLimits(weekInput(at(2026, 9, 30, 8), 13), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 12, from: 'previous-reading' });
});

test('a later reading on the same day keeps the day baseline', () => {
  const file = weekFile(at(2026, 9, 30, 9), 13, { date: '2026-09-30', percent: 12, from: 'previous-reading' });
  recordRateLimits(weekInput(at(2026, 9, 30, 11), 15), file);
  const written = readBack(file);
  assert.strictEqual(written.rate_limits.seven_day.used_percentage, 15);
  assert.deepStrictEqual(written.dayStart, { date: '2026-09-30', percent: 12, from: 'previous-reading' });
});

test('a weekly reset since the previous reading starts the day at 0', () => {
  const oldReset = at(2026, 9, 30, 5);
  const file = weekFile(at(2026, 9, 29, 18), 90, { date: '2026-09-29', percent: 80, from: 'previous-reading' }, oldReset);
  recordRateLimits(weekInput(at(2026, 9, 30, 8), 2, at(2026, 10, 7, 5)), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 0, from: 'reset' });
});

test('a weekly reset in the middle of the day restarts the day at 0, and later readings keep that', () => {
  const oldReset = at(2026, 9, 30, 5);
  const newReset = at(2026, 10, 7, 5);
  const file = weekFile(at(2026, 9, 30, 4), 95, { date: '2026-09-30', percent: 88, from: 'previous-reading' }, oldReset);
  recordRateLimits(weekInput(at(2026, 9, 30, 6), 1, newReset), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 0, from: 'reset' });
  recordRateLimits(weekInput(at(2026, 9, 30, 7), 3, newReset), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 0, from: 'reset' });
});

test('a skipped older reading leaves the day baseline alone', () => {
  const dayStart = { date: '2026-09-30', percent: 12, from: 'previous-reading' };
  const file = weekFile(at(2026, 9, 30, 11), 15, dayStart);
  recordRateLimits(weekInput(at(2026, 9, 30, 10), 99), file);
  const written = readBack(file);
  assert.strictEqual(written.rate_limits.seven_day.used_percentage, 15);
  assert.deepStrictEqual(written.dayStart, dayStart);
});

test('a reading with no weekly window keeps a same-day baseline and replaces an old one', () => {
  const sameDay = weekFile(at(2026, 9, 30, 9), 13, { date: '2026-09-30', percent: 12, from: 'previous-reading' });
  recordRateLimits(statuslineInput({ transcript_path: makeTranscript(at(2026, 9, 30, 10)) }), sameDay);
  assert.deepStrictEqual(readBack(sameDay).dayStart, { date: '2026-09-30', percent: 12, from: 'previous-reading' });

  const oldDay = weekFile(at(2026, 9, 29, 9), 13, { date: '2026-09-29', percent: 12, from: 'previous-reading' });
  recordRateLimits(statuslineInput({ transcript_path: makeTranscript(at(2026, 9, 30, 10)) }), oldDay);
  assert.deepStrictEqual(readBack(oldDay).dayStart, { date: '2026-09-30', percent: 13, from: 'previous-reading' });
});

test('with a weekly window the file holds dayStart and still nothing else from the input', () => {
  const file = missingFile('rate-limits.json');
  recordRateLimits(weekInput(at(2026, 9, 30, 9), 13), file);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('super-secret-session-id-should-not-be-written'));
  assert.deepStrictEqual(Object.keys(JSON.parse(raw)).sort(), ['dayStart', 'fetchedAtMs', 'rate_limits']);
});

test('readDailyShare on a workday reports the share, the fixed budget and the rolling budget', () => {
  // Wednesday: Wed, Thu and Fri are left before the Sunday 05:00 reset.
  const file = weekFile(at(2026, 9, 30, 9), 17, { date: '2026-09-30', percent: 13, from: 'previous-reading' });
  assert.deepStrictEqual(readDailyShare({ rateLimits: file, now: at(2026, 9, 30, 10) }), {
    date: '2026-09-30',
    weekPercent: 17,
    dayStartPercent: 13,
    share: 4,
    from: 'previous-reading',
    workday: true,
    budget: 20,
    rollingBudget: 29,
    workdaysLeft: 3,
    resetsAt: RESET,
  });
});

test('readDailyShare on a weekend reports the share with no budget', () => {
  const file = weekFile(at(2026, 10, 3, 9), 70, { date: '2026-10-03', percent: 66, from: 'previous-reading' });
  const share = readDailyShare({ rateLimits: file, now: at(2026, 10, 3, 10) });
  assert.strictEqual(share.share, 4);
  assert.strictEqual(share.workday, false);
  assert.strictEqual(share.budget, null);
  assert.strictEqual(share.rollingBudget, null);
  assert.strictEqual(share.workdaysLeft, null);
});

test('readDailyShare reports 0 for a day with no reading yet', () => {
  const file = weekFile(at(2026, 9, 29, 18), 12, { date: '2026-09-29', percent: 9, from: 'previous-reading' });
  const share = readDailyShare({ rateLimits: file, now: at(2026, 9, 30, 8) });
  assert.strictEqual(share.share, 0);
  assert.strictEqual(share.dayStartPercent, 12);
  assert.strictEqual(share.from, 'no-reading-today');
});

test('readDailyShare reports 0 once the weekly window has reset with no newer reading', () => {
  const oldReset = at(2026, 9, 30, 5);
  const file = weekFile(at(2026, 9, 30, 4), 95, { date: '2026-09-30', percent: 88, from: 'previous-reading' }, oldReset);
  const share = readDailyShare({ rateLimits: file, now: at(2026, 9, 30, 6) });
  assert.strictEqual(share.weekPercent, 0);
  assert.strictEqual(share.share, 0);
  assert.strictEqual(share.from, 'reset');
  assert.strictEqual(share.resetsAt, null);
});

test('a reset at 05:00 does not count its own day as a workday left', () => {
  // Monday to the next Monday 05:00: Mon-Fri count, the next Monday does not.
  const nextMonday = at(2026, 10, 5, 5);
  const file = weekFile(at(2026, 9, 28, 9), 5, { date: '2026-09-28', percent: 3, from: 'previous-reading' }, nextMonday);
  const share = readDailyShare({ rateLimits: file, now: at(2026, 9, 28, 10) });
  assert.strictEqual(share.workdaysLeft, 5);
  assert.strictEqual(share.rollingBudget, (100 - 3) / 5);
});

test('a workday whose window closes before noon has no rolling budget but keeps the fixed one', () => {
  const file = weekFile(at(2026, 9, 30, 7), 60, { date: '2026-09-30', percent: 58, from: 'previous-reading' }, at(2026, 9, 30, 10));
  const share = readDailyShare({ rateLimits: file, now: at(2026, 9, 30, 8) });
  assert.strictEqual(share.workdaysLeft, 0);
  assert.strictEqual(share.rollingBudget, null);
  assert.strictEqual(share.budget, 20);
});

test('readDailyShare never reports a negative share', () => {
  const file = weekFile(at(2026, 9, 30, 9), 18, { date: '2026-09-30', percent: 20, from: 'previous-reading' });
  assert.strictEqual(readDailyShare({ rateLimits: file, now: at(2026, 9, 30, 10) }).share, 0);
});

test('readDailyShare returns null with no file or no weekly window', () => {
  assert.strictEqual(readDailyShare({ rateLimits: missingFile('rate-limits.json'), now: NOW }), null);
  const noWeek = writeRateLimits({ fetchedAtMs: FETCHED, rate_limits: { five_hour: { used_percentage: 5, resets_at: null } } });
  assert.strictEqual(readDailyShare({ rateLimits: noWeek, now: NOW }), null);
});

test('a reading with no weekly window after a reset still starts the day at 0', () => {
  // Claude Code drops a window whose reset has passed, so the first reading after a
  // reset can carry only the five-hour window.
  const oldReset = at(2026, 9, 30, 5);
  const newReset = at(2026, 10, 7, 5);
  const file = weekFile(at(2026, 9, 30, 4), 95, { date: '2026-09-30', percent: 88, from: 'previous-reading' }, oldReset);
  recordRateLimits(statuslineInput({ transcript_path: makeTranscript(at(2026, 9, 30, 6)) }), file);
  recordRateLimits(weekInput(at(2026, 9, 30, 7), 1, newReset), file);
  recordRateLimits(weekInput(at(2026, 9, 30, 15), 18, newReset), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 0, from: 'reset' });
  assert.strictEqual(readDailyShare({ rateLimits: file, now: at(2026, 9, 30, 15, 5) }).share, 18);
});

test('a reading with no weekly window on a new day keeps the previous reading as the baseline', () => {
  const file = weekFile(at(2026, 9, 29, 18), 12, { date: '2026-09-29', percent: 9, from: 'previous-reading' });
  recordRateLimits(statuslineInput({ transcript_path: makeTranscript(at(2026, 9, 30, 8)) }), file);
  recordRateLimits(weekInput(at(2026, 9, 30, 9), 14), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 12, from: 'previous-reading' });
});

test('a previous reading from earlier the same day, with no baseline, counts the day from that reading', () => {
  // The first write after upgrading: the file has a same-morning reading and no dayStart.
  const file = weekFile(at(2026, 9, 29, 9, 30), 21);
  recordRateLimits(weekInput(at(2026, 9, 29, 9, 50), 22), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-29', percent: 21, from: 'first-reading' });
});

test('a previous reading just before midnight, with no baseline, starts the new day', () => {
  const file = weekFile(at(2026, 9, 29, 23, 59), 12);
  recordRateLimits(weekInput(at(2026, 9, 30, 0, 1), 13), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 12, from: 'previous-reading' });
});

test('a previous reading just after midnight, with no baseline, counts as the same day', () => {
  const file = weekFile(at(2026, 9, 30, 0, 1), 12);
  recordRateLimits(weekInput(at(2026, 9, 30, 8), 13), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 12, from: 'first-reading' });
});

test('a weekly reset since a same-day previous reading, with no baseline, starts the day at 0', () => {
  const oldReset = at(2026, 9, 30, 5);
  const file = weekFile(at(2026, 9, 30, 4), 95, undefined, oldReset);
  recordRateLimits(weekInput(at(2026, 9, 30, 6), 1, at(2026, 10, 7, 5)), file);
  assert.deepStrictEqual(readBack(file).dayStart, { date: '2026-09-30', percent: 0, from: 'reset' });
});
