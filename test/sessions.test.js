'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { recordSession, getSessionsDir } = require('../lib/sessions');

// Real time, not a fixed date: recordSession prunes by comparing the files it
// just wrote, whose mtime is the real clock, against now.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-sessions-'));
}

function makeTranscript(mtimeMs) {
  const file = path.join(tmpDir(), 'transcript.jsonl');
  fs.writeFileSync(file, '{}\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function statuslineInput(overrides = {}) {
  return {
    session_id: 'abc-123',
    transcript_path: makeTranscript(NOW - 60_000),
    cwd: '/Users/someone/code/other',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: '/Users/someone/code/demo/sub', project_dir: '/Users/someone/code/demo' },
    cost: {
      total_cost_usd: 1.25,
      total_duration_ms: 600_000,
      total_api_duration_ms: 120_000,
      total_lines_added: 40,
      total_lines_removed: 7,
    },
    ...overrides,
  };
}

function readSnapshot(dir, id = 'abc-123') {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
}

test('recordSession writes the panel fields and nothing else', () => {
  const dir = tmpDir();
  recordSession(statuslineInput(), dir, NOW);
  assert.deepStrictEqual(readSnapshot(dir), {
    sessionId: 'abc-123',
    lastActiveAt: NOW - 60_000,
    project: 'demo',
    model: 'Opus 5.5',
    costUsd: 1.25,
    durationMs: 600_000,
    apiDurationMs: 120_000,
    linesAdded: 40,
    linesRemoved: 7,
  });
});

test('recordSession falls back to current_dir, then cwd, for the project', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ workspace: { current_dir: '/x/fallback' } }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).project, 'fallback');
  recordSession(statuslineInput({ workspace: undefined, cost: { ...statuslineInput().cost, total_duration_ms: 700_000 } }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).project, 'other');
});

test('recordSession uses the write time when the transcript is unreadable', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ transcript_path: path.join(tmpDir(), 'missing.jsonl') }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).lastActiveAt, NOW);
});

test('recordSession skips an older snapshot of the same session', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ cost: { ...statuslineInput().cost, total_duration_ms: 900_000, total_cost_usd: 2 } }), dir, NOW);
  recordSession(statuslineInput(), dir, NOW); // total_duration_ms 600_000: an earlier render finishing late
  const written = readSnapshot(dir);
  assert.strictEqual(written.durationMs, 900_000);
  assert.strictEqual(written.costUsd, 2);
});

test('recordSession rejects an unsafe session id', () => {
  const parent = tmpDir();
  const dir = path.join(parent, 'sessions');
  for (const id of ['../x', 'a/b', '..', '.', '', 42, null, 'a'.repeat(129)]) {
    recordSession(statuslineInput({ session_id: id }), dir, NOW);
  }
  assert.deepStrictEqual(fs.readdirSync(parent).filter((f) => f !== 'sessions'), []);
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('recordSession writes nothing without a cost block', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ cost: undefined }), dir, NOW);
  recordSession(statuslineInput({ cost: { total_cost_usd: 'free' } }), dir, NOW);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('recordSession zeroes numbers that are not finite and non-negative', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ cost: { total_cost_usd: 0.5, total_duration_ms: -1, total_api_duration_ms: 'x', total_lines_added: Infinity } }), dir, NOW);
  const written = readSnapshot(dir);
  assert.strictEqual(written.costUsd, 0.5);
  assert.strictEqual(written.durationMs, 0);
  assert.strictEqual(written.apiDurationMs, 0);
  assert.strictEqual(written.linesAdded, 0);
  assert.strictEqual(written.linesRemoved, 0);
});

test('recordSession prunes day-old files and keeps recent ones', () => {
  const dir = tmpDir();
  const old = path.join(dir, 'old-session.json');
  const oldTmp = path.join(dir, 'old-session.json.4242');
  const recent = path.join(dir, 'recent-session.json');
  for (const f of [old, oldTmp, recent]) fs.writeFileSync(f, '{}');
  const past = (NOW - DAY - 60_000) / 1000;
  fs.utimesSync(old, past, past);
  fs.utimesSync(oldTmp, past, past);
  const hourAgo = (NOW - 3_600_000) / 1000;
  fs.utimesSync(recent, hourAgo, hourAgo);
  recordSession(statuslineInput(), dir, NOW);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['abc-123.json', 'recent-session.json']);
});

test('recordSession prunes only its own snapshot files', () => {
  const dir = tmpDir();
  const notes = path.join(dir, 'notes.txt');
  const backup = path.join(dir, 'backup.json.bak');
  const badName = path.join(dir, 'bad name.json');
  const old = path.join(dir, 'old-session.json');
  for (const f of [notes, backup, badName, old]) fs.writeFileSync(f, '{}');
  const past = (NOW - DAY - 60_000) / 1000;
  for (const f of [notes, backup, badName, old]) fs.utimesSync(f, past, past);
  recordSession(statuslineInput(), dir, NOW);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['abc-123.json', 'backup.json.bak', 'bad name.json', 'notes.txt']);
});

test('recordSession never throws, even when the directory cannot be created', () => {
  const blocker = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(blocker, '');
  assert.doesNotThrow(() => recordSession(statuslineInput(), path.join(blocker, 'sessions'), NOW));
  assert.doesNotThrow(() => recordSession(undefined, tmpDir(), NOW));
});

test('getSessionsDir follows LIVE_SESSIONS_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  const saved = { LIVE_SESSIONS_DIR: process.env.LIVE_SESSIONS_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  try {
    process.env.LIVE_SESSIONS_DIR = '~/elsewhere';
    assert.strictEqual(getSessionsDir(), path.join(os.homedir(), 'elsewhere'));
    delete process.env.LIVE_SESSIONS_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    assert.strictEqual(getSessionsDir(), path.join('/tmp/cfg', 'cc-dashboard', 'sessions'));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.strictEqual(getSessionsDir(), path.join(os.homedir(), '.claude', 'cc-dashboard', 'sessions'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

function runBin(name, input, env) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', name)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

for (const name of ['record-statusline', 'record-limits']) {
  test(`bin/${name} writes the session snapshot and the rate limits`, () => {
    const sessions = tmpDir();
    const limits = path.join(tmpDir(), 'rate-limits.json');
    const input = statuslineInput({ rate_limits: { five_hour: { used_percentage: 12.5, resets_at: null } } });
    const result = runBin(name, JSON.stringify(input), { LIVE_SESSIONS_DIR: sessions, RATE_LIMITS_JSON: limits });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(readSnapshot(sessions).costUsd, 1.25);
    assert.strictEqual(JSON.parse(fs.readFileSync(limits, 'utf8')).rate_limits.five_hour.used_percentage, 12.5);
  });

  test(`bin/${name} still writes the rate limits when the cost block is missing`, () => {
    const sessions = tmpDir();
    const limits = path.join(tmpDir(), 'rate-limits.json');
    const input = statuslineInput({ cost: undefined, rate_limits: { five_hour: { used_percentage: 3, resets_at: null } } });
    const result = runBin(name, JSON.stringify(input), { LIVE_SESSIONS_DIR: sessions, RATE_LIMITS_JSON: limits });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout + result.stderr, '');
    assert.deepStrictEqual(fs.readdirSync(sessions), []);
    assert.strictEqual(JSON.parse(fs.readFileSync(limits, 'utf8')).rate_limits.five_hour.used_percentage, 3);
  });

  test(`bin/${name} is silent and exits 0 on bad input`, () => {
    const result = runBin(name, 'not json', { LIVE_SESSIONS_DIR: tmpDir(), RATE_LIMITS_JSON: path.join(tmpDir(), 'r.json') });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout + result.stderr, '');
  });
}

test('both bin scripts are executable', () => {
  for (const name of ['record-statusline', 'record-limits']) {
    const mode = fs.statSync(path.join(__dirname, '..', 'bin', name)).mode;
    assert.ok(mode & 0o100, `${name} has the owner exec bit`);
  }
});
