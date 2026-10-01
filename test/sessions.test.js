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

test('every bin script is executable', () => {
  for (const name of ['record-statusline', 'record-limits', 'record-session-end']) {
    const mode = fs.statSync(path.join(__dirname, '..', 'bin', name)).mode;
    assert.ok(mode & 0o100, `${name} has the owner exec bit`);
  }
});

const { readSessions, buildLiveSessions, LIVE_WINDOW_MS } = require('../lib/sessions');

function localMidnight(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function snapshot(overrides = {}) {
  return {
    sessionId: 's1',
    lastActiveAt: NOW - 60_000,
    project: 'demo',
    model: 'Opus 5.5',
    costUsd: 1,
    durationMs: 600_000,
    apiDurationMs: 60_000,
    linesAdded: 10,
    linesRemoved: 2,
    ...overrides,
  };
}

function writeSnapshots(list) {
  const dir = tmpDir();
  for (const s of list) fs.writeFileSync(path.join(dir, `${s.sessionId}.json`), JSON.stringify(s));
  return dir;
}

test('readSessions keeps only today, newest first', () => {
  const midnight = localMidnight(NOW);
  const dir = writeSnapshots([
    snapshot({ sessionId: 'yesterday', lastActiveAt: midnight - 1 }),
    snapshot({ sessionId: 'early', lastActiveAt: midnight }),
    snapshot({ sessionId: 'late', lastActiveAt: NOW - 1000 }),
  ]);
  assert.deepStrictEqual(readSessions(dir, NOW).map((s) => s.sessionId), ['late', 'early']);
});

test('readSessions skips unreadable files', () => {
  const dir = writeSnapshots([snapshot({ sessionId: 'good' })]);
  fs.writeFileSync(path.join(dir, 'half.json'), '{"sessionId":"half","lastAc');
  fs.writeFileSync(path.join(dir, 'wrong-shape.json'), JSON.stringify({ sessionId: 'x' }));
  fs.writeFileSync(path.join(dir, 'good.json.999'), JSON.stringify(snapshot({ sessionId: 'tmp' })));
  assert.deepStrictEqual(readSessions(dir, NOW).map((s) => s.sessionId), ['good']);
});

test('readSessions returns [] when the directory does not exist', () => {
  assert.deepStrictEqual(readSessions(path.join(tmpDir(), 'none'), NOW), []);
});

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

test('buildLiveSessions joins tokens by sessionId and totals the rows', () => {
  const snaps = [
    snapshot({ sessionId: 's1', costUsd: 1.5, apiDurationMs: 60_000, linesAdded: 10, linesRemoved: 2, lastActiveAt: NOW - 60_000 }),
    snapshot({ sessionId: 's2', costUsd: 0.5, apiDurationMs: 30_000, linesAdded: 1, linesRemoved: 0, lastActiveAt: NOW - LIVE_WINDOW_MS - 1 }),
  ];
  const calls = [
    { sessionId: 's1', context: 1000, output: 200, cost: 0.2 },
    { sessionId: 's1', context: 500, output: 50, cost: 0.05 },
    { sessionId: 's2', context: 10, output: 5, cost: 0.01 },
    { sessionId: 'other', context: 99999, output: 1, cost: 9 },
  ];
  const result = buildLiveSessions(snaps, calls, NOW);
  assert.deepStrictEqual(result.sessions.map((s) => [s.tokens, s.live]), [[1750, true], [15, false]]);
  assert.deepStrictEqual(result.sessions.map((s) => round6(s.costTodayUsd)), [0.25, 0.01]);
  assert.strictEqual('sessionId' in result.sessions[0], false);
  assert.strictEqual(round6(result.total.costTodayUsd), 0.26);
  assert.deepStrictEqual({ ...result.total, costTodayUsd: round6(result.total.costTodayUsd) }, {
    costUsd: 2, costTodayUsd: 0.26, apiDurationMs: 90_000, linesAdded: 11, linesRemoved: 2, tokens: 1765,
  });
});

test('buildLiveSessions gives 0 tokens to a session with no calls today', () => {
  const result = buildLiveSessions([snapshot()], [], NOW);
  assert.strictEqual(result.sessions[0].tokens, 0);
  assert.strictEqual(result.sessions[0].costTodayUsd, 0);
  assert.strictEqual(result.total.tokens, 0);
});

test('buildLiveSessions with no snapshots is an empty list and zero totals', () => {
  assert.deepStrictEqual(buildLiveSessions([], [{ sessionId: 'x', context: 1, output: 1, cost: 1 }], NOW), {
    sessions: [],
    total: { costUsd: 0, costTodayUsd: 0, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 },
  });
});

const { recordSessionEnd } = require('../lib/sessions');

const readFile = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));

test('recordSessionEnd marks an existing snapshot and leaves its other fields alone', () => {
  const dir = writeSnapshots([snapshot({ sessionId: 's1' })]);
  recordSessionEnd({ session_id: 's1', reason: 'clear' }, dir, NOW);
  assert.deepStrictEqual(readFile(dir, 's1'), { ...snapshot({ sessionId: 's1' }), endedAt: NOW, endReason: 'clear' });
});

test('recordSessionEnd writes nothing without a snapshot, a safe id, or a reason', () => {
  const empty = tmpDir();
  recordSessionEnd({ session_id: 's1', reason: 'clear' }, empty, NOW);
  assert.deepStrictEqual(fs.readdirSync(empty), []);

  const dir = writeSnapshots([snapshot({ sessionId: 's1' })]);
  const before = fs.readFileSync(path.join(dir, 's1.json'), 'utf8');
  recordSessionEnd({ session_id: '../s1', reason: 'clear' }, dir, NOW);
  recordSessionEnd({ session_id: 's1' }, dir, NOW);
  recordSessionEnd(null, dir, NOW);
  assert.strictEqual(fs.readFileSync(path.join(dir, 's1.json'), 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['s1.json']);
});

test('recordSession keeps endedAt and endReason when it rewrites a snapshot', () => {
  const dir = tmpDir();
  recordSession(statuslineInput(), dir, NOW);
  recordSessionEnd({ session_id: 'abc-123', reason: 'clear' }, dir, NOW);
  recordSession(statuslineInput({ cost: { ...statuslineInput().cost, total_cost_usd: 2 } }), dir, NOW);
  const written = readSnapshot(dir);
  assert.strictEqual(written.costUsd, 2);
  assert.strictEqual(written.endedAt, NOW);
  assert.strictEqual(written.endReason, 'clear');
});

test('readSessions keeps a valid end and drops malformed end fields', () => {
  const dir = writeSnapshots([
    snapshot({ sessionId: 'good', lastActiveAt: NOW - 5000, endedAt: NOW - 1000, endReason: 'prompt_input_exit' }),
    snapshot({ sessionId: 'bad', lastActiveAt: NOW - 10_000, endedAt: 'soon', endReason: '<script>' }),
  ]);
  const [good, bad] = readSessions(dir, NOW);
  assert.strictEqual(good.endedAt, NOW - 1000);
  assert.strictEqual(good.endReason, 'prompt_input_exit');
  assert.strictEqual(bad.sessionId, 'bad');
  assert.strictEqual('endedAt' in bad, false);
  assert.strictEqual('endReason' in bad, false);
});

test('buildLiveSessions marks an ended session as not live, with its reason', () => {
  const result = buildLiveSessions([
    snapshot({ sessionId: 'cleared', lastActiveAt: NOW - 60_000, endedAt: NOW - 30_000, endReason: 'clear' }),
    snapshot({ sessionId: 'resumed', lastActiveAt: NOW - 10_000, endedAt: NOW - 30_000, endReason: 'resume' }),
    snapshot({ sessionId: 'no-reason', lastActiveAt: NOW - 60_000, endedAt: NOW - 30_000 }),
    snapshot({ sessionId: 'open', lastActiveAt: NOW - 60_000 }),
  ], [], NOW);
  // Rows are sorted by lastActiveAt, newest first, so 'resumed' comes first.
  assert.deepStrictEqual(result.sessions.map((s) => [s.ended, s.live]), [
    [null, true],
    ['clear', false],
    ['other', false],
    [null, true],
  ]);
});

test('buildLiveSessions counts ended sessions in the totals', () => {
  const result = buildLiveSessions([
    snapshot({ sessionId: 's1', costUsd: 1.5, endedAt: NOW, endReason: 'clear' }),
    snapshot({ sessionId: 's2', costUsd: 0.5 }),
  ], [], NOW);
  assert.strictEqual(result.total.costUsd, 2);
});

test('bin/record-session-end marks the snapshot and prints nothing', () => {
  const dir = writeSnapshots([snapshot({ sessionId: 's1' })]);
  const input = JSON.stringify({ session_id: 's1', reason: 'clear', hook_event_name: 'SessionEnd', cwd: '/tmp' });
  const result = runBin('record-session-end', input, { LIVE_SESSIONS_DIR: dir });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout + result.stderr, '');
  assert.strictEqual(readFile(dir, 's1').endReason, 'clear');
});

test('bin/record-session-end is silent and exits 0 on bad or empty input', () => {
  for (const input of ['not json', '', 'null']) {
    const result = runBin('record-session-end', input, { LIVE_SESSIONS_DIR: tmpDir() });
    assert.strictEqual(result.status, 0, `input ${JSON.stringify(input)}`);
    assert.strictEqual(result.stdout + result.stderr, '', `input ${JSON.stringify(input)}`);
  }
});

test('buildLiveSessions keeps a session ended when its last activity is within END_GRACE_MS after the end', () => {
  const { END_GRACE_MS } = require('../lib/sessions');
  const result = buildLiveSessions([
    snapshot({ sessionId: 'late-render', lastActiveAt: NOW - 30_000 + END_GRACE_MS, endedAt: NOW - 30_000, endReason: 'clear' }),
    snapshot({ sessionId: 'resumed', lastActiveAt: NOW - 30_000 + END_GRACE_MS + 1, endedAt: NOW - 30_000, endReason: 'clear' }),
  ], [], NOW);
  assert.strictEqual(END_GRACE_MS, 5000);
  // Rows are sorted by lastActiveAt, newest first, so 'resumed' comes first.
  assert.deepStrictEqual(result.sessions.map((s) => [s.ended, s.live]), [[null, true], ['clear', false]]);
});

test('buildLiveSessions counts a subagent call as activity for its parent session', () => {
  const snap = snapshot({ sessionId: 's1', lastActiveAt: NOW - LIVE_WINDOW_MS - 60_000 });
  const calls = [{ sessionId: 's1', t: NOW - 30_000, context: 10, output: 5, cost: 0.01 }];
  const [row] = buildLiveSessions([snap], calls, NOW).sessions;
  assert.strictEqual(row.live, true, 'a call 30s ago makes the session live');
  assert.strictEqual(row.lastActiveAt, NOW - 30_000);
});

test('buildLiveSessions orders rows by last activity, counting subagent calls', () => {
  const snaps = [
    snapshot({ sessionId: 'a', lastActiveAt: NOW - 60_000 }),
    snapshot({ sessionId: 'b', lastActiveAt: NOW - 120_000 }),
  ];
  const calls = [{ sessionId: 'b', t: NOW - 1_000, context: 1, output: 1, cost: 0 }];
  assert.deepStrictEqual(
    buildLiveSessions(snaps, calls, NOW).sessions.map((s) => s.lastActiveAt),
    [NOW - 1_000, NOW - 60_000]
  );
});
