'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pace = require('../lib/pace');
const { addReading, computePace } = pace;

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// "20@-4/A" -> entry 4 minutes before NOW, 20 percent, session A.
function entries(spec) {
  return spec.map((s) => {
    const m = /^(\d+)@(-?\d+)(?:\/(\w+))?$/.exec(s);
    return { t: NOW + Number(m[2]) * MIN, percent: Number(m[1]), sessionId: m[3] || null };
  });
}
function run(spec, resetsInMin) {
  return computePace(entries(spec), Math.round((NOW + resetsInMin * MIN) / 1000), NOW);
}
function near(a, b) {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
}

test('computePace P1 one entry is idle', () => {
  assert.strictEqual(run(['20@-2'], 240).state, 'idle');
});
test('computePace P2 no rise is idle', () => {
  assert.strictEqual(run(['10@-10', '10@-1'], 240).state, 'idle');
});
test('computePace P3 steady climb is fast and names the session', () => {
  const p = run(['20@-4/A', '22@-3/A', '24@-2/A', '26@-1/A', '28@0/A'], 240);
  assert.strictEqual(p.state, 'fast');
  near(p.ratePerHour, 120);
  near(p.fastPerHour, 24);
  near(p.runsOutAt, NOW + 36 * MIN);
  assert.strictEqual(p.busySessionId, 'A');
  assert.strictEqual(p.percent, 28);
});
test('computePace P4 entries one minute apart are steady', () => {
  assert.strictEqual(run(['20@-1', '27@0'], 240).state, 'steady');
});
test('computePace P5 divides by now minus the oldest entry', () => {
  const p = run(['20@-14', '27@-13'], 240);
  assert.strictEqual(p.state, 'steady');
  near(p.ratePerHour, 30);
});
test('computePace P6 a rise of 5 is steady', () => {
  assert.strictEqual(run(['20@-5', '25@0'], 240).state, 'steady');
});
test('computePace P7 entries older than the span are ignored', () => {
  const p = run(['10@-16', '20@-14', '21@0'], 240);
  assert.strictEqual(p.state, 'steady');
  near(p.ratePerHour, 1 / (14 / 60));
});
test('computePace P8 margin shrinks to half the time left', () => {
  const p = run(['73@-6', '76@-3', '80@0'], 40);
  assert.strictEqual(p.state, 'fast');
  near(p.fastPerHour, 60);
  near(p.ratePerHour, 70);
});
test('computePace P9 a rate equal to the fast pace is steady', () => {
  const p = run(['74@-6', '80@0'], 40);
  assert.strictEqual(p.state, 'steady');
  assert.strictEqual(p.ratePerHour, 60);
});
test('computePace P10 spent window is null', () => {
  assert.strictEqual(run(['100@-5', '100@0'], 60), null);
});
test('computePace P11 passed reset is null', () => {
  assert.strictEqual(run(['20@-5', '30@0'], 0), null);
});
test('computePace P12 tie between sessions names the newest entry', () => {
  const p = run(['20@-6/A', '22@-5/B', '24@-4/A', '26@-3/B', '28@0'], 240);
  assert.strictEqual(p.busySessionId, 'B');
});
test('computePace P13 no session ids names none', () => {
  const p = run(['20@-6', '28@0'], 240);
  assert.strictEqual(p.busySessionId, null);
});
test('computePace P14 a slower rise still trips fast', () => {
  const p = run(['20@-11', '26@-7'], 244);
  assert.strictEqual(p.state, 'fast');
  near(p.ratePerHour, 6 / (11 / 60));
  near(p.fastPerHour, 74 / (184 / 60));
});
test('computePace P15 the same entries four minutes later decay to steady', () => {
  const p = run(['20@-15', '26@-11'], 240);
  assert.strictEqual(p.state, 'steady');
  near(p.ratePerHour, 24);
  near(p.fastPerHour, 74 / 3);
});
test('computePace returns null for an empty list', () => {
  assert.strictEqual(computePace([], Math.round((NOW + 240 * MIN) / 1000), NOW), null);
});
test('computePace runsOutAt is null when the rate is 0', () => {
  assert.strictEqual(run(['10@-10', '10@-1'], 240).runsOutAt, null);
});
test('computePace an oldest entry at now is idle', () => {
  const p = run(['10@0', '20@0'], 240);
  assert.strictEqual(p.state, 'idle');
});

const R = 1_800_010_000;
function reading(over) {
  return { t: NOW, percent: 10, sessionId: 'A', resetsAt: R, accountUuid: null, ...over };
}

test('addReading with a null cache starts a list', () => {
  const r = addReading(null, reading());
  assert.deepStrictEqual(r, {
    fiveHourRecent: [{ t: NOW, percent: 10, sessionId: 'A' }],
    fiveHourResetsAt: R,
  });
});
test('addReading appends in t order', () => {
  const c = addReading(null, reading({ t: NOW - MIN, percent: 9 }));
  const r = addReading(c, reading());
  assert.deepStrictEqual(r.fiveHourRecent.map((e) => e.percent), [9, 10]);
});
test('addReading inserts an older reading in t order', () => {
  let c = addReading(null, reading({ t: NOW - 2 * MIN, percent: 8 }));
  c = addReading(c, reading({ t: NOW, percent: 10 }));
  const r = addReading(c, reading({ t: NOW - MIN, percent: 9 }));
  assert.deepStrictEqual(r.fiveHourRecent.map((e) => e.percent), [8, 9, 10]);
});
test('addReading drops entries more than 20 minutes older than the newest', () => {
  let c = addReading(null, reading({ t: NOW - 25 * MIN, percent: 1 }));
  c = addReading(c, reading({ t: NOW - 19 * MIN, percent: 2 }));
  const r = addReading(c, reading({ t: NOW, percent: 3 }));
  assert.deepStrictEqual(r.fiveHourRecent.map((e) => e.percent), [2, 3]);
});
test('addReading keeps the newest 60', () => {
  let c = null;
  for (let i = 0; i < 61; i++) c = addReading(c, reading({ t: NOW + i * 1000, percent: i }));
  assert.strictEqual(c.fiveHourRecent.length, 60);
  assert.strictEqual(c.fiveHourRecent[0].percent, 1);
  assert.strictEqual(c.fiveHourRecent[59].percent, 60);
});
test('addReading restarts on a new resetsAt', () => {
  const c = addReading(null, reading());
  const r = addReading(c, reading({ t: NOW + MIN, percent: 1, resetsAt: R + 18000 }));
  assert.deepStrictEqual(r, {
    fiveHourRecent: [{ t: NOW + MIN, percent: 1, sessionId: 'A' }],
    fiveHourResetsAt: R + 18000,
  });
});
test('addReading restarts on a new accountUuid', () => {
  const c = { ...addReading(null, reading()), accountUuid: 'one' };
  const r = addReading(c, reading({ t: NOW + MIN, percent: 11, accountUuid: 'two' }));
  assert.deepStrictEqual(r.fiveHourRecent, [{ t: NOW + MIN, percent: 11, sessionId: 'A' }]);
});
test('addReading keeps the list when either accountUuid is null or missing', () => {
  const base = addReading(null, reading());
  const a = addReading({ ...base, accountUuid: 'one' }, reading({ t: NOW + MIN, accountUuid: null }));
  assert.strictEqual(a.fiveHourRecent.length, 2);
  const b = addReading({ ...base, accountUuid: null }, reading({ t: NOW + MIN, accountUuid: 'two' }));
  assert.strictEqual(b.fiveHourRecent.length, 2);
  const c = addReading(base, reading({ t: NOW + MIN, accountUuid: 'two' }));
  assert.strictEqual(c.fiveHourRecent.length, 2);
});
test('addReading restarts on another account even with an earlier resetsAt', () => {
  const c = { ...addReading(null, reading()), accountUuid: 'one' };
  const r = addReading(c, reading({ t: NOW + MIN, percent: 3, resetsAt: R - 18000, accountUuid: 'two' }));
  assert.deepStrictEqual(r, {
    fiveHourRecent: [{ t: NOW + MIN, percent: 3, sessionId: 'A' }],
    fiveHourResetsAt: R - 18000,
  });
});
test('addReading ignores a late reading from the previous window', () => {
  const c = addReading(null, reading());
  const r = addReading(c, reading({ t: NOW + MIN, percent: 99, resetsAt: R - 18000 }));
  assert.deepStrictEqual(r, { fiveHourRecent: c.fiveHourRecent, fiveHourResetsAt: R });
});

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A temp config with rate-limits.json holding P3's entries (fast, busy session A).
function seedPace(sessionFiles = { 'A.json': '{"project":"cc-dashboard"}' }, fileOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-'));
  tempDirs.push(dir);
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir);
  for (const [name, text] of Object.entries(sessionFiles)) fs.writeFileSync(path.join(sessionsDir, name), text);
  const rateLimits = path.join(dir, 'rate-limits.json');
  const resetsAt = Math.round((NOW + 240 * MIN) / 1000);
  fs.writeFileSync(rateLimits, JSON.stringify({
    fetchedAtMs: NOW,
    rate_limits: { five_hour: { used_percentage: 28, resets_at: resetsAt } },
    fiveHourRecent: entries(['20@-4/A', '22@-3/A', '24@-2/A', '26@-1/A', '28@0/A']),
    fiveHourResetsAt: resetsAt,
    ...fileOverrides,
  }));
  return { dir, rateLimits, sessionsDir, resetsAt };
}

test('readPace reads the busy session\'s project from its snapshot', () => {
  const { rateLimits, sessionsDir, resetsAt } = seedPace();
  const p = pace.readPace({ rateLimits, sessionsDir, now: NOW });
  assert.strictEqual(p.state, 'fast');
  assert.strictEqual(p.resetsAt, resetsAt * 1000);
  assert.deepStrictEqual(p.busy, { sessionId: 'A', project: 'cc-dashboard' });
});
test('readPace returns null without fiveHourRecent', () => {
  const { rateLimits, sessionsDir } = seedPace({}, { fiveHourRecent: undefined });
  assert.strictEqual(pace.readPace({ rateLimits, sessionsDir, now: NOW }), null);
  assert.strictEqual(pace.readPace({ rateLimits: path.join(sessionsDir, 'none.json'), sessionsDir, now: NOW }), null);
});
test('readPace rejects a session id with a path separator', () => {
  const { dir, rateLimits, sessionsDir, resetsAt } = seedPace({}, {});
  fs.writeFileSync(path.join(dir, 'x.json'), '{"project":"leak"}');
  const recent = entries(['20@-4', '22@-3', '24@-2', '26@-1', '28@0']).map((e) => ({ ...e, sessionId: '../x' }));
  fs.writeFileSync(rateLimits, JSON.stringify({ fetchedAtMs: NOW, fiveHourRecent: recent, fiveHourResetsAt: resetsAt }));
  const p = pace.readPace({ rateLimits, sessionsDir, now: NOW });
  assert.strictEqual(p.busy.project, null);
});
test('readPace returns null when the file belongs to another account', () => {
  const { dir, rateLimits, sessionsDir } = seedPace({}, { accountUuid: 'one' });
  const claudeJson = path.join(dir, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { accountUuid: 'two' } }));
  assert.strictEqual(pace.readPace({ rateLimits, sessionsDir, claudeJson, now: NOW }), null);
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { accountUuid: 'one' } }));
  assert.strictEqual(pace.readPace({ rateLimits, sessionsDir, claudeJson, now: NOW }).state, 'fast');
});
