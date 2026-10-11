'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { recordSession, getSessionsDir } = require('../lib/sessions');

// Real time, not a fixed date: recordSession prunes by comparing the files it
// just wrote, whose mtime is the real clock, against now.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function tmpDir() {
  return helpers.tmpDir(null, 'sessions');
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

test('recordSession stores a launch_id as launchId', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ launch_id: 'mfz3k1-a8c2e9f0' }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).launchId, 'mfz3k1-a8c2e9f0');
});

test('recordSession leaves out a launch_id that is not a safe id string', () => {
  for (const launch_id of [42, { id: 'x' }, '../x', '', 'a b', 'x'.repeat(129)]) {
    const dir = tmpDir();
    recordSession(statuslineInput({ launch_id }), dir, NOW);
    const snap = readSnapshot(dir);
    assert.ok(!('launchId' in snap), `launch_id ${JSON.stringify(launch_id)} was stored`);
    assert.strictEqual(snap.sessionId, 'abc-123');
  }
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

test('recordSession replaces a longer snapshot when the transcript is newer', () => {
  const dir = tmpDir();
  const T = NOW - 120_000;
  const cost = statuslineInput().cost;
  recordSession(statuslineInput({ transcript_path: makeTranscript(T), cost: { ...cost, total_duration_ms: 7_200_000 } }), dir, NOW);
  recordSession(statuslineInput({ transcript_path: makeTranscript(T + 60_000), cost: { ...cost, total_duration_ms: 300_000 } }), dir, NOW);
  const written = readSnapshot(dir);
  assert.strictEqual(written.durationMs, 300_000);
  assert.strictEqual(written.lastActiveAt, T + 60_000);
});

test('recordSession skips a snapshot whose transcript is older, whatever its duration', () => {
  const dir = tmpDir();
  const T = NOW - 120_000;
  const cost = statuslineInput().cost;
  recordSession(statuslineInput({ transcript_path: makeTranscript(T), cost: { ...cost, total_duration_ms: 300_000 } }), dir, NOW);
  recordSession(statuslineInput({ transcript_path: makeTranscript(T - 60_000), cost: { ...cost, total_duration_ms: 900_000 } }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).durationMs, 300_000);
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
  assert.strictEqual(fs.statSync(blocker).isFile(), true, 'the blocking file is untouched');
  assert.strictEqual(fs.existsSync(path.join(blocker, 'sessions')), false, 'nothing was created under the blocker');

  const empty = tmpDir();
  assert.doesNotThrow(() => recordSession(undefined, empty, NOW));
  assert.deepStrictEqual(fs.readdirSync(empty), [], 'a missing statusline input writes no snapshot');
});

test('getSessionsDir is under the config dir', () => {
  assert.strictEqual(getSessionsDir('/cfg'), path.join('/cfg', 'cc-dashboard', 'sessions'));
});

// A throwaway config dir for a bin script, with its sessions folder already made.
function configDir() {
  const config = tmpDir();
  const sessions = path.join(config, 'cc-dashboard', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { config, sessions, limits: path.join(config, 'rate-limits.json') };
}

function runBin(name, input, config) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', name)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  });
}

test('bin/record-statusline records with a PORT that the server would refuse', () => {
  const { config, sessions } = configDir();
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'record-statusline')], {
    input: JSON.stringify(statuslineInput()),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, PORT: 'abc' },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, '');
  assert.strictEqual(readSnapshot(sessions).sessionId, 'abc-123');
});

for (const name of ['record-statusline']) {
  test(`bin/${name} writes the session snapshot and the rate limits`, () => {
    const { config, sessions, limits } = configDir();
    const input = statuslineInput({ rate_limits: { five_hour: { used_percentage: 12.5, resets_at: null } } });
    const result = runBin(name, JSON.stringify(input), config);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(readSnapshot(sessions).costUsd, 1.25);
    assert.strictEqual(JSON.parse(fs.readFileSync(limits, 'utf8')).rate_limits.five_hour.used_percentage, 12.5);
  });

  test(`bin/${name} still writes the rate limits when the cost block is missing`, () => {
    const { config, sessions, limits } = configDir();
    const input = statuslineInput({ cost: undefined, rate_limits: { five_hour: { used_percentage: 3, resets_at: null } } });
    const result = runBin(name, JSON.stringify(input), config);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout + result.stderr, '');
    assert.deepStrictEqual(fs.readdirSync(sessions), []);
    assert.strictEqual(JSON.parse(fs.readFileSync(limits, 'utf8')).rate_limits.five_hour.used_percentage, 3);
  });

  test(`bin/${name} is silent and exits 0 on bad input`, () => {
    const result = runBin(name, 'not json', configDir().config);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout + result.stderr, '');
  });
}

test('every bin script is executable', () => {
  for (const name of ['record-statusline', 'record-session-end']) {
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

test('buildLiveSessions lists each session\'s cache rebuilds, oldest first', () => {
  const snaps = [snapshot({ sessionId: 's1', lastActiveAt: NOW - 60_000 }), snapshot({ sessionId: 's2', lastActiveAt: NOW - 60_000 })];
  const r = (cause, premium) => ({ cause, reason: null, tokens: 50_000, gapMs: 600_000, premium });
  const calls = [
    { sessionId: 's1', t: NOW - 2_000, main: false, context: 1, output: 1, cost: 0.1, rebuild: r('expired', 0.2) },
    { sessionId: 's1', t: NOW - 9_000, main: true, context: 1, output: 1, cost: 0.1, rebuild: r('tools', 0.3) },
    { sessionId: 's1', t: NOW - 5_000, main: true, context: 1, output: 1, cost: 0.1 },
    { sessionId: 's2', t: NOW - 5_000, main: true, context: 1, output: 1, cost: 0.1 },
  ];
  const { sessions } = buildLiveSessions(snaps, calls, NOW);
  const s1 = sessions.find((s) => s.rebuilds.length);
  assert.deepStrictEqual(s1.rebuilds, [
    { t: NOW - 9_000, main: true, ...r('tools', 0.3) },
    { t: NOW - 2_000, main: false, ...r('expired', 0.2) },
  ]);
  assert.deepStrictEqual(sessions.map((s) => s.rebuilds.length).sort(), [0, 2]);
});

test('buildLiveSessions joins tokens and lines by sessionId and totals the rows', () => {
  const snaps = [
    snapshot({ sessionId: 's1', costUsd: 1.5, lastActiveAt: NOW - 60_000 }),
    snapshot({ sessionId: 's2', costUsd: 0.5, lastActiveAt: NOW - LIVE_WINDOW_MS - 1 }),
  ];
  const calls = [
    { sessionId: 's1', context: 1000, output: 200, cost: 0.2 },
    { sessionId: 's1', context: 500, output: 50, cost: 0.05 },
    { sessionId: 's2', context: 10, output: 5, cost: 0.01 },
    { sessionId: 'other', context: 99999, output: 1, cost: 9 },
  ];
  const lines = { s1: { added: 10, removed: 2 }, s2: { added: 1, removed: 0 }, other: { added: 500, removed: 500 } };
  const result = buildLiveSessions(snaps, calls, NOW, lines);
  assert.deepStrictEqual(result.sessions.map((s) => [s.tokens, s.live]), [[1750, true], [15, false]]);
  assert.deepStrictEqual(result.sessions.map((s) => [s.linesAdded, s.linesRemoved]), [[10, 2], [1, 0]]);
  assert.deepStrictEqual(result.sessions.map((s) => round6(s.costTodayUsd)), [0.25, 0.01]);
  assert.strictEqual('sessionId' in result.sessions[0], false);
  assert.strictEqual('model' in result.sessions[0], false);
  assert.strictEqual('apiDurationMs' in result.sessions[0], false);
  assert.deepStrictEqual({ ...result.total, costTodayUsd: round6(result.total.costTodayUsd) }, {
    costUsd: 2, costTodayUsd: 0.26, linesAdded: 11, linesRemoved: 2, tokens: 1765,
  });
});

test("buildLiveSessions ignores the snapshot's own line counts", () => {
  const result = buildLiveSessions([snapshot({ linesAdded: 40, linesRemoved: 9, apiDurationMs: 120_000 })], [], NOW);
  assert.deepStrictEqual([result.sessions[0].linesAdded, result.sessions[0].linesRemoved], [0, 0]);
  assert.deepStrictEqual(result.total, { costUsd: 1, costTodayUsd: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 });
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
    total: { costUsd: 0, costTodayUsd: 0, linesAdded: 0, linesRemoved: 0, tokens: 0 },
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

test('recordSession keeps launchId when a later write has none or an invalid one', () => {
  const dir = tmpDir();
  recordSession(statuslineInput({ launch_id: 'L1' }), dir, NOW);
  const longer = { ...statuslineInput().cost, total_duration_ms: statuslineInput().cost.total_duration_ms + 1000 };
  recordSession(statuslineInput({ cost: longer }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).launchId, 'L1');
  const longest = { ...longer, total_duration_ms: longer.total_duration_ms + 1000 };
  recordSession(statuslineInput({ cost: longest, launch_id: '../bad' }), dir, NOW);
  assert.strictEqual(readSnapshot(dir).launchId, 'L1');
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
  const { config, sessions } = configDir();
  fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify(snapshot({ sessionId: 's1' })));
  const input = JSON.stringify({ session_id: 's1', reason: 'clear', hook_event_name: 'SessionEnd', cwd: '/tmp' });
  const result = runBin('record-session-end', input, config);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout + result.stderr, '');
  assert.strictEqual(readFile(sessions, 's1').endReason, 'clear');
});

test('bin/record-session-end is silent and exits 0 on bad or empty input', () => {
  for (const input of ['not json', '', 'null']) {
    const result = runBin('record-session-end', input, configDir().config);
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

test('buildLiveSessions adds the title from titleBySession', () => {
  const { sessions } = buildLiveSessions([snapshot()], [], NOW, {}, { s1: 'Ideas and planning' });
  assert.strictEqual(sessions[0].title, 'Ideas and planning');
});

test('buildLiveSessions gives a null title to a session without one', () => {
  const { sessions } = buildLiveSessions([snapshot()], [], NOW, {}, { other: 'Elsewhere' });
  assert.strictEqual(sessions[0].title, null);
  assert.strictEqual(buildLiveSessions([snapshot()], [], NOW).sessions[0].title, null);
});

test('buildLiveSessions passes launchId through, and gives null without one', () => {
  const { sessions } = buildLiveSessions(
    [snapshot({ sessionId: 's1', launchId: 'L1' }), snapshot({ sessionId: 's2', lastActiveAt: NOW - 120_000 })],
    [], NOW
  );
  assert.deepStrictEqual(sessions.map((s) => s.launchId), ['L1', null]);
});

test('buildLiveSessions takes the branch from branchBySession and the list from branchesBySession', () => {
  const meta = { branchesBySession: { s1: ['main', 'feat/x'] }, branchBySession: { s1: 'main' } };
  const [s] = buildLiveSessions([snapshot()], [], NOW, {}, {}, [], new Map(), meta).sessions;
  assert.deepStrictEqual([s.branch, s.branches], ['main', ['main', 'feat/x']]);
});

test('buildLiveSessions gives a null branch and an empty list to a session without one', () => {
  const [s] = buildLiveSessions([snapshot()], [], NOW).sessions;
  assert.deepStrictEqual([s.branch, s.branches], [null, []]);
});

test('buildLiveSessions takes the title from the ai-title, else the first prompt, and says which', () => {
  const meta = { firstPromptBySession: { s1: 'look at ideas' } };
  const fromPrompt = buildLiveSessions([snapshot()], [], NOW, {}, {}, [], new Map(), meta).sessions[0];
  assert.deepStrictEqual([fromPrompt.title, fromPrompt.titleSource], ['look at ideas', 'prompt']);
  // Claude Code writes its ai-title after the first few turns. Once it exists, it wins.
  const fromAi = buildLiveSessions([snapshot()], [], NOW, {}, { s1: 'Ideas' }, [], new Map(), meta).sessions[0];
  assert.deepStrictEqual([fromAi.title, fromAi.titleSource], ['Ideas', 'ai']);
  const none = buildLiveSessions([snapshot()], [], NOW).sessions[0];
  assert.deepStrictEqual([none.title, none.titleSource], [null, null]);
});

test('buildLiveSessions turns a session\'s call times into spans, splitting at a gap over LIVE_WINDOW_MS', () => {
  const t0 = NOW - 3 * 60 * 60 * 1000;
  const calls = [
    { sessionId: 's1', t: t0 + 60_000, context: 1, output: 1, cost: 0 },
    { sessionId: 's1', t: t0, context: 1, output: 1, cost: 0 },
    // exactly LIVE_WINDOW_MS after the previous call: still the same span
    { sessionId: 's1', t: t0 + 60_000 + LIVE_WINDOW_MS, context: 1, output: 1, cost: 0 },
    // more than LIVE_WINDOW_MS after the previous call: a new span
    { sessionId: 's1', t: t0 + 60_000 + 2 * LIVE_WINDOW_MS + 1, context: 1, output: 1, cost: 0 },
    { sessionId: 'other', t: t0, context: 1, output: 1, cost: 0 },
  ];
  const [row] = buildLiveSessions([snapshot()], calls, NOW).sessions;
  assert.deepStrictEqual(row.spans, [
    [t0, t0 + 60_000 + LIVE_WINDOW_MS],
    [t0 + 60_000 + 2 * LIVE_WINDOW_MS + 1, t0 + 60_000 + 2 * LIVE_WINDOW_MS + 1],
  ]);
});

test('buildLiveSessions gives a one-call span start === end', () => {
  const calls = [{ sessionId: 's1', t: NOW - 5_000, context: 1, output: 1, cost: 0 }];
  assert.deepStrictEqual(buildLiveSessions([snapshot()], calls, NOW).sessions[0].spans, [[NOW - 5_000, NOW - 5_000]]);
});

test('buildLiveSessions counts a subagent call in the parent session spans', () => {
  // Subagent calls carry the parent sessionId, so they are plain entries of calls.
  const calls = [
    { sessionId: 's1', t: NOW - 20 * 60_000, main: true, context: 1, output: 1, cost: 0 },
    { sessionId: 's1', t: NOW - 19 * 60_000, main: false, context: 1, output: 1, cost: 0 },
  ];
  assert.deepStrictEqual(buildLiveSessions([snapshot()], calls, NOW).sessions[0].spans, [[NOW - 20 * 60_000, NOW - 19 * 60_000]]);
});

test('buildLiveSessions gives spans [] to a session with no calls, and ignores a call with no time', () => {
  assert.deepStrictEqual(buildLiveSessions([snapshot()], [], NOW).sessions[0].spans, []);
  const calls = [{ sessionId: 's1', context: 1, output: 1, cost: 0 }];
  assert.deepStrictEqual(buildLiveSessions([snapshot()], calls, NOW).sessions[0].spans, []);
});

test('buildLiveSessions counts the session\'s typed prompts from the prompts argument', () => {
  const prompts = [
    { t: NOW - 3000, sessionId: 's1' },
    { t: NOW - 2000, sessionId: 's1' },
    { t: NOW - 1000, sessionId: 'other' },
  ];
  const { sessions } = buildLiveSessions([snapshot(), snapshot({ sessionId: 's2' })], [], NOW, {}, {}, prompts);
  assert.deepStrictEqual(sessions.map((s) => s.prompts).sort(), [0, 2]);
  assert.strictEqual(buildLiveSessions([snapshot()], [], NOW).sessions[0].prompts, 0);
});

function activityEntry(overrides = {}) {
  return { sessionId: 's1', state: 'working', since: NOW - 30_000, tool: { name: 'Bash', detail: 'npm test', startedAt: NOW - 20_000 }, subagents: 1, updatedAt: NOW - 10_000, ...overrides };
}

test('buildLiveSessions joins activity by session id and drops the session id from it', () => {
  const map = new Map([['s1', activityEntry()]]);
  const { sessions } = buildLiveSessions([snapshot()], [], NOW, {}, {}, [], map);
  assert.deepStrictEqual(sessions[0].activity, {
    state: 'working', since: NOW - 30_000, tool: { name: 'Bash', detail: 'npm test', startedAt: NOW - 20_000 }, subagents: 1,
  });
});

test('buildLiveSessions gives null activity when the map has no entry or is left out', () => {
  assert.strictEqual(buildLiveSessions([snapshot()], [], NOW).sessions[0].activity, null);
  assert.strictEqual(buildLiveSessions([snapshot()], [], NOW, {}, {}, [], new Map([['other', activityEntry({ sessionId: 'other' })]])).sessions[0].activity, null);
});

test('buildLiveSessions does not create a session from activity that has no snapshot', () => {
  const map = new Map([['other', activityEntry({ sessionId: 'other' })]]);
  const { sessions } = buildLiveSessions([snapshot()], [], NOW, {}, {}, [], map);
  assert.strictEqual(sessions.length, 1);
});

test('buildLiveSessions ignores the activity of an ended session', () => {
  const map = new Map([['s1', activityEntry()]]);
  const snap = snapshot({ endedAt: NOW - 1000, endReason: 'clear' });
  assert.strictEqual(buildLiveSessions([snap], [], NOW, {}, {}, [], map).sessions[0].activity, null);
});

test('buildLiveSessions drops stale working activity but keeps waiting', () => {
  const stale = NOW - 11 * 60_000;
  const working = new Map([['s1', activityEntry({ updatedAt: stale })]]);
  const waiting = new Map([['s1', activityEntry({ state: 'waiting', tool: null, subagents: 0, updatedAt: stale })]]);
  assert.strictEqual(buildLiveSessions([snapshot()], [], NOW, {}, {}, [], working).sessions[0].activity, null);
  assert.strictEqual(buildLiveSessions([snapshot()], [], NOW, {}, {}, [], waiting).sessions[0].activity.state, 'waiting');
});

test('buildLiveSessions keeps waiting activity on a session that is no longer live', () => {
  // runningSessions (Task 3.6) lists a session waiting on you even after it stops
  // being live, so the API must keep its activity. This pins what the API sends.
  const old = snapshot({ lastActiveAt: NOW - 3 * 60 * 60 * 1000 });
  const map = new Map([['s1', activityEntry({ state: 'waiting', tool: null, subagents: 0, updatedAt: NOW - 3 * 60 * 60 * 1000 })]]);
  const [row] = buildLiveSessions([old], [], NOW, {}, {}, [], map).sessions;
  assert.strictEqual(row.live, false);
  assert.strictEqual(row.activity.state, 'waiting');
});

test('buildLiveSessions keeps a stale waiting session with subagents as waiting with no subagents', () => {
  const old = snapshot({ lastActiveAt: NOW - 3 * 60 * 60 * 1000 });
  const map = new Map([['s1', activityEntry({ state: 'waiting', tool: null, subagents: 2, updatedAt: NOW - 3 * 60 * 60 * 1000 })]]);
  const [row] = buildLiveSessions([old], [], NOW, {}, {}, [], map).sessions;
  assert.deepStrictEqual(row.activity, { state: 'waiting', since: NOW - 30_000, tool: null, subagents: 0 });
});

// Cache countdown: the `cache` field of a session waiting on the user.
const TTL_5M = 5 * 60_000;
const TTL_1H = 60 * 60_000;

function waitingMap(sessionId = 's1') {
  return new Map([[sessionId, activityEntry({ state: 'waiting', tool: null, subagents: 0, updatedAt: NOW - 30_000 })]]);
}

function cacheCall(overrides = {}) {
  return { sessionId: 's1', t: NOW - 60_000, main: true, model: 'claude-opus-5-5', context: 100_000, output: 10, cost: 0.1, write5m: 0, write1h: 0, ...overrides };
}

function liveCache(calls, activity = waitingMap()) {
  return buildLiveSessions([snapshot()], calls, NOW, {}, {}, [], activity).sessions[0].cache;
}

test('a waiting session with a 5-minute write has a 5-minute cache', () => {
  const t = NOW - 60_000;
  const cache = liveCache([cacheCall({ t, write5m: 100_000 })]);
  assert.strictEqual(cache.ttl, '5m');
  assert.strictEqual(cache.expiresAt, t + TTL_5M);
  assert.strictEqual(cache.minutesLeft, 4);
});

test('a waiting session with a 1-hour write has a 1-hour cache', () => {
  const t = NOW - 10 * 60_000;
  const cache = liveCache([cacheCall({ t, write1h: 100_000 })]);
  assert.strictEqual(cache.ttl, '1h');
  assert.strictEqual(cache.expiresAt, t + TTL_1H);
  assert.strictEqual(cache.minutesLeft, 50);
});

test('a newest call that only read the cache keeps the earlier TTL', () => {
  const t = NOW - 2 * 60_000;
  const cache = liveCache([
    cacheCall({ t: NOW - 20 * 60_000, write1h: 100_000 }),
    cacheCall({ t, write1h: 0, write5m: 0 }),
  ]);
  assert.strictEqual(cache.ttl, '1h');
  assert.strictEqual(cache.expiresAt, t + TTL_1H);
});

test('the TTL is found in time order, whatever the order of the calls', () => {
  const cache = liveCache([
    cacheCall({ t: NOW - 2 * 60_000 }),
    cacheCall({ t: NOW - 20 * 60_000, write1h: 100_000 }),
  ]);
  assert.strictEqual(cache.ttl, '1h');
});

test('a session with only reads defaults to a 5-minute cache', () => {
  assert.strictEqual(liveCache([cacheCall()]).ttl, '5m');
});

test('an expired cache has a negative minutesLeft', () => {
  const t = NOW - 6 * 60_000;
  const cache = liveCache([cacheCall({ t, write5m: 100_000 })]);
  assert.strictEqual(cache.expiresAt, t + TTL_5M);
  assert.strictEqual(cache.minutesLeft, -1);
});

test('a cache with under a minute left has minutesLeft 0', () => {
  const cache = liveCache([cacheCall({ t: NOW - TTL_5M + 30_000, write5m: 100_000 })]);
  assert.strictEqual(cache.minutesLeft, 0);
});

test('a working session has no cache field', () => {
  const working = new Map([['s1', activityEntry({ state: 'working', tool: null, subagents: 0, updatedAt: NOW - 1000 })]]);
  const row = buildLiveSessions([snapshot()], [cacheCall({ write5m: 1 })], NOW, {}, {}, [], working).sessions[0];
  assert.strictEqual('cache' in row, false);
});

test('a session without the mod has no cache field', () => {
  const row = buildLiveSessions([snapshot()], [cacheCall({ write5m: 1 })], NOW).sessions[0];
  assert.strictEqual('cache' in row, false);
});

test('a waiting session with no main calls has no cache field', () => {
  const row = buildLiveSessions([snapshot()], [cacheCall({ main: false, write5m: 1 })], NOW, {}, {}, [], waitingMap()).sessions[0];
  assert.strictEqual('cache' in row, false);
});

test('subagent calls do not move the cache expiry or its size', () => {
  const t = NOW - 60_000;
  const cache = liveCache([
    cacheCall({ t, write5m: 100_000 }),
    cacheCall({ t: NOW - 1000, main: false, write1h: 500_000, context: 500_000, model: 'claude-haiku-4-5' }),
  ]);
  assert.strictEqual(cache.ttl, '5m');
  assert.strictEqual(cache.expiresAt, t + TTL_5M);
});

// Opus 5.5 in lib/pricing.js: input $4/M, 5m write 1.25x, 1h write 2x, read 0.05x.
test('rebuildUsd is the write cost of the newest context minus its read cost', () => {
  const five = liveCache([cacheCall({ write5m: 100_000, context: 100_000 })]);
  assert.strictEqual(round6(five.rebuildUsd), 0.48);
  const hour = liveCache([cacheCall({ write1h: 100_000, context: 100_000 })]);
  assert.strictEqual(round6(hour.rebuildUsd), 0.78);
});

test('rebuildUsd is null for an unpriced model', () => {
  assert.strictEqual(liveCache([cacheCall({ model: 'claude-unknown-9', write5m: 100_000 })]).rebuildUsd, null);
  assert.strictEqual(liveCache([cacheCall({ model: null, write5m: 100_000 })]).rebuildUsd, null);
});
