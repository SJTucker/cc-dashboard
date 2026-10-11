'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('../lib/sqlite');
const helpers = require('./helpers');

const { readRtkUsage, readRtkWindows, readRtkDaily } = require('../lib/rtk');

// Build a throwaway database with rtk's exact schema. Timestamps are written as
// UTC ISO strings with an explicit +00:00 offset, matching what rtk stores.
function makeDb(rows) {
  const dir = helpers.tmpDir(null, 'rtk');
  const file = path.join(dir, 'history.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE commands (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      original_cmd TEXT NOT NULL,
      rtk_cmd TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      saved_tokens INTEGER NOT NULL,
      savings_pct REAL NOT NULL,
      exec_time_ms INTEGER DEFAULT 0,
      project_path TEXT DEFAULT ''
    );
    CREATE INDEX idx_timestamp ON commands(timestamp);
  `);
  const ins = db.prepare(
    `INSERT INTO commands
       (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    ins.run(
      r.timestamp,
      r.original_cmd ?? 'grep foo',
      r.rtk_cmd ?? 'rtk grep foo',
      r.input_tokens ?? 100,
      r.output_tokens ?? 40,
      r.saved_tokens ?? 60,
      r.savings_pct ?? 60.0,
      r.exec_time_ms ?? 5,
      r.project_path ?? '/tmp/demo'
    );
  }
  db.close();
  return file;
}

// A UTC ISO string, 6-digit fraction and +00:00 offset, for a given local Date.
function utcStamp(d) {
  return d.toISOString().replace('Z', '000+00:00');
}

// The estimate in lib/rtk.js. Each case is one command; keptOut = without - with.
test('content commands count their whole output on both sides', () => {
  const now = utcStamp(new Date());
  const file = makeDb([
    { timestamp: now, rtk_cmd: 'rtk read', original_cmd: 'cat big.js', input_tokens: 20000, output_tokens: 9000, saved_tokens: 11000 },
    { timestamp: now, rtk_cmd: 'rtk git diff HEAD~1', original_cmd: 'git diff HEAD~1', input_tokens: 12000, output_tokens: 3000, saved_tokens: 9000 },
    { timestamp: now, rtk_cmd: 'rtk git show abc', original_cmd: 'git show abc', input_tokens: 500, output_tokens: 200, saved_tokens: 300 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  assert.strictEqual(out.commands.find((c) => c.name === 'read').keptOut, 11000);
  assert.strictEqual(out.commands.find((c) => c.name === 'git').keptOut, 9300);
});

test('status commands count at most 750 tokens without rtk', () => {
  const now = utcStamp(new Date());
  const file = makeDb([
    { timestamp: now, rtk_cmd: 'rtk vitest run', original_cmd: 'vitest run', input_tokens: 1145263, output_tokens: 5, saved_tokens: 1145258 },
    { timestamp: now, rtk_cmd: 'rtk cargo test', original_cmd: 'cargo test', input_tokens: 300, output_tokens: 20, saved_tokens: 280 },
    { timestamp: now, rtk_cmd: 'rtk tsc', original_cmd: 'tsc', input_tokens: 900, output_tokens: 6738, saved_tokens: 0 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  const kept = Object.fromEntries(out.commands.map((c) => [c.name, c.keptOut]));
  assert.deepStrictEqual(kept, { vitest: 745, cargo: 280, tsc: -5988 });
  assert.strictEqual(out.commands.find((c) => c.name === 'vitest').filtered, 1145258, 'rtk\'s own figure is still reported');
});

test('other commands are capped at the inline limit on both sides', () => {
  const now = utcStamp(new Date());
  const file = makeDb([
    { timestamp: now, rtk_cmd: 'rtk grep a', original_cmd: 'grep a', input_tokens: 7500, output_tokens: 100 },
    { timestamp: now, rtk_cmd: 'rtk find b', original_cmd: 'find b', input_tokens: 7501, output_tokens: 100 },
    { timestamp: now, rtk_cmd: 'rtk ls', original_cmd: 'ls -R', input_tokens: 30000, output_tokens: 7501 },
    { timestamp: now, rtk_cmd: 'rtk git status', original_cmd: 'git status', input_tokens: 27304, output_tokens: 7225 },
    { timestamp: now, rtk_cmd: 'rtk frobnicate x', original_cmd: 'frobnicate x', input_tokens: 100, output_tokens: 10 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  const kept = Object.fromEntries(out.commands.map((c) => [c.name, c.keptOut]));
  assert.deepStrictEqual(kept, {
    grep: 7400, // 7,500 fits inline
    find: 2400, // 7,501 does not: 2,500 - 100
    ls: 0, // both sides over the limit
    git: -4725, // git status is not content: 2,500 - 7,225
    frobnicate: 90, // an unknown subcommand counts as other
  });
});

test('a negative command stays negative in the summary, the day and the detail row', () => {
  const file = makeDb([
    { timestamp: utcStamp(new Date()), rtk_cmd: 'rtk tsc', original_cmd: 'tsc --noEmit', input_tokens: 900, output_tokens: 6738, saved_tokens: 0 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  assert.strictEqual(out.summary.keptOut, -5988);
  assert.strictEqual(out.daily.at(-1).keptOut, -5988);
  assert.strictEqual(out.commands[0].keptOut, -5988);
  assert.strictEqual(out.commands[0].details[0].keptOut, -5988);
});

test('readRtkUsage reports raw and filtered beside keptOut, and drops the old fields', () => {
  const file = makeDb([
    { timestamp: utcStamp(new Date()), rtk_cmd: 'rtk grep x', original_cmd: 'grep x', input_tokens: 800, output_tokens: 300, saved_tokens: 500 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  assert.deepStrictEqual(out.summary, { totalCommands: 1, raw: 800, filtered: 500, keptOut: 500 });
  assert.deepStrictEqual(out.commands[0].details, [{ name: 'grep x', calls: 1, raw: 800, filtered: 500, keptOut: 500 }]);
  const day = out.daily.at(-1);
  assert.deepStrictEqual(Object.keys(day).sort(), ['commands', 'date', 'filtered', 'keptOut', 'raw']);
  assert.ok(!('saved' in out.commands[0]) && !('input' in out.commands[0]));
});

test('commands are ordered by keptOut, not by rtk\'s figure', () => {
  const now = utcStamp(new Date());
  const file = makeDb([
    { timestamp: now, rtk_cmd: 'rtk vitest run', original_cmd: 'vitest run', input_tokens: 1145263, output_tokens: 5, saved_tokens: 1145258 },
    { timestamp: now, rtk_cmd: 'rtk read', original_cmd: 'cat a', input_tokens: 1000, output_tokens: 0, saved_tokens: 1000 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  assert.deepStrictEqual(out.commands.map((c) => c.name), ['read', 'vitest']);
});

test('daily buckets use LOCAL dates, not the stored UTC date', () => {
  // 23:30 local today. In any timezone west of UTC this stores as tomorrow's UTC
  // date, so a substr(timestamp,1,10) implementation puts it on the wrong bar.
  const local = new Date();
  local.setHours(23, 30, 0, 0);
  const file = makeDb([{ timestamp: utcStamp(local), saved_tokens: 500, input_tokens: 800 }]);

  const out = readRtkUsage({ days: 7, dbPath: file });
  const expectedDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;

  assert.strictEqual(out.daily.length, 1);
  assert.strictEqual(out.daily[0].date, expectedDay, 'bucketed by local date');
  assert.strictEqual(out.daily[0].filtered, 500);
  assert.strictEqual(out.daily[0].commands, 1);
});

test('commands are grouped by rtk subcommand with an original_cmd level below', () => {
  const now = new Date();
  const file = makeDb([
    { timestamp: utcStamp(now), rtk_cmd: 'rtk grep alpha', original_cmd: 'grep alpha', saved_tokens: 100, input_tokens: 200 },
    { timestamp: utcStamp(now), rtk_cmd: 'rtk grep beta', original_cmd: 'grep beta', saved_tokens: 50, input_tokens: 100 },
    { timestamp: utcStamp(now), rtk_cmd: 'rtk grep alpha', original_cmd: 'grep alpha', saved_tokens: 25, input_tokens: 75 },
    { timestamp: utcStamp(now), rtk_cmd: 'rtk read', original_cmd: 'cat x', saved_tokens: 900, input_tokens: 1000 },
  ]);

  const out = readRtkUsage({ days: 7, dbPath: file });

  assert.deepStrictEqual(
    out.commands.map((c) => [c.name, c.calls, c.filtered, c.keptOut]),
    [['read', 1, 900, 960], ['grep', 3, 175, 255]],
    'sorted by keptOut, descending'
  );
  const grep = out.commands.find((c) => c.name === 'grep');
  assert.deepStrictEqual(
    grep.details.map((d) => [d.name, d.calls, d.keptOut]),
    [['grep alpha', 2, 195], ['grep beta', 1, 60]],
    'detail rows are distinct original_cmd values, keptOut-descending'
  );
  assert.strictEqual(out.summary.totalCommands, 4);
  assert.strictEqual(out.summary.filtered, 1075);
  assert.strictEqual(out.summary.raw, 1375);
});

test('a subcommand with no arguments still groups correctly', () => {
  const file = makeDb([
    { timestamp: utcStamp(new Date()), rtk_cmd: 'rtk read', original_cmd: 'cat a', saved_tokens: 10 },
  ]);
  const out = readRtkUsage({ days: 7, dbPath: file });
  assert.strictEqual(out.commands[0].name, 'read', 'no trailing space to trip the substr');
});

test('a missing database returns an empty payload, not a throw', () => {
  const file = path.join(os.tmpdir(), 'definitely-not-here', 'history.db');
  const out = readRtkUsage({ days: 7, dbPath: file });
  assert.strictEqual(out.meta.dbExists, false);
  assert.deepStrictEqual(out.daily, []);
  assert.deepStrictEqual(out.commands, []);
  assert.strictEqual(out.summary.totalCommands, 0);
});

test('a range cutoff excludes older rows at either fractional-second width', () => {
  const now = Date.now();
  const recent = new Date(now - 2 * 86400000); // inside a 7-day window
  const old = new Date(now - 30 * 86400000); // outside it
  const file = makeDb([
    // 6-digit fraction, the common case
    { timestamp: recent.toISOString().replace('Z', '000+00:00'), saved_tokens: 7 },
    { timestamp: old.toISOString().replace('Z', '000+00:00'), saved_tokens: 999 },
    // 3-digit fraction, the 17-row minority on the reference database
    { timestamp: recent.toISOString().replace('Z', '+00:00'), saved_tokens: 3 },
    { timestamp: old.toISOString().replace('Z', '+00:00'), saved_tokens: 999 },
  ]);

  const windowed = readRtkUsage({ days: 7, dbPath: file });
  assert.strictEqual(windowed.summary.totalCommands, 2, 'both recent rows, neither old one');
  assert.strictEqual(windowed.summary.filtered, 10);

  const all = readRtkUsage({ days: null, dbPath: file });
  assert.strictEqual(all.summary.totalCommands, 4, 'days:null reads the whole table');
});

test('hour bucketing produces the same key shape lib/dates.js uses', () => {
  const at14 = new Date();
  at14.setHours(14, 5, 0, 0);
  const file = makeDb([{ timestamp: utcStamp(at14), saved_tokens: 42 }]);

  const out = readRtkUsage({ days: 'today', bucket: 'hour', dbPath: file });
  // Length is the full-day axis, asserted by its own test; this one is about the
  // key shape, which has to match lib/dates.js so shortDate()/fullDate() parse it.
  const at14Bucket = out.daily.find((d) => d.filtered === 42);
  assert.match(at14Bucket.date, /^\d{4}-\d{2}-\d{2}T14$/);
});

test('a file that exists but is not an rtk database degrades to an empty payload', () => {
  const dir = helpers.tmpDir(null, 'rtk-bad');

  // Junk bytes: sqlite rejects this at the first statement, not at open.
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'this is definitely not a sqlite file\n');
  const fromJunk = readRtkUsage({ days: 7, dbPath: junk });
  assert.strictEqual(fromJunk.meta.dbExists, false, 'junk file reports no usable database');
  assert.deepStrictEqual(fromJunk.daily, []);
  assert.strictEqual(fromJunk.summary.totalCommands, 0);

  // A real sqlite file that simply is not rtk's: opens fine, has no `commands`.
  const wrong = path.join(dir, 'wrong-schema.db');
  const other = new DatabaseSync(wrong);
  other.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
  other.close();
  const fromWrong = readRtkUsage({ days: 7, dbPath: wrong });
  assert.strictEqual(fromWrong.meta.dbExists, false, 'wrong schema reports no usable database');
  assert.deepStrictEqual(fromWrong.commands, []);
});

test('detail rows are capped per command, keeping the largest', () => {
  const now = new Date();
  // 20 distinct original_cmd values under one subcommand, saving 1..20 tokens.
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push({
      timestamp: utcStamp(now),
      rtk_cmd: 'rtk grep x',
      original_cmd: `grep pattern-${String(i).padStart(2, '0')}`,
      saved_tokens: i,
      input_tokens: 100,
      output_tokens: 100 - i,
    });
  }
  const file = makeDb(rows);
  const out = readRtkUsage({ days: 7, dbPath: file });

  const grep = out.commands.find((c) => c.name === 'grep');
  assert.strictEqual(grep.calls, 20, 'the parent row still counts every call');
  assert.strictEqual(grep.keptOut, 210, 'and still sums every call');
  assert.strictEqual(grep.details.length, 12, 'but the detail level is capped');
  assert.strictEqual(grep.details[0].name, 'grep pattern-20', 'largest first');
  assert.strictEqual(grep.details[11].name, 'grep pattern-09', 'and the 12 largest are the ones kept');
});

test('a negative detail row survives the cap, and the rows come back keptOut descending', () => {
  const now = utcStamp(new Date());
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ timestamp: now, rtk_cmd: 'rtk grep x', original_cmd: `grep pos-${i}`, input_tokens: 100, output_tokens: 100 - (10 + i), saved_tokens: 10 + i });
  }
  rows.push({ timestamp: now, rtk_cmd: 'rtk grep x', original_cmd: 'grep neg', input_tokens: 50, output_tokens: 100, saved_tokens: 0 });
  const grep = readRtkUsage({ days: 7, dbPath: makeDb(rows) }).commands.find((c) => c.name === 'grep');
  assert.strictEqual(grep.details.length, 12);
  assert.ok(grep.details.some((d) => d.name === 'grep neg'), 'the -50 row is kept');
  assert.ok(!grep.details.some((d) => d.name === 'grep pos-0'), 'the smallest positive row (10) is dropped');
  assert.strictEqual(grep.details[11].name, 'grep neg', 'and it sorts last');
  assert.deepStrictEqual(grep.details.map((d) => d.keptOut), [21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, -50]);
});

test('the Today range gets a full-day hour axis, not just the hours with rows', () => {
  const at13 = new Date();
  at13.setHours(13, 20, 0, 0);
  const file = makeDb([{ timestamp: utcStamp(at13), saved_tokens: 42, input_tokens: 90 }]);

  const out = readRtkUsage({ days: 'today', bucket: 'hour', dbPath: file });

  // 23 on the spring-forward day, where 2am does not exist locally - the same
  // shape lib/dates.js produces, so the two Today charts share an axis.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const expectedSlots = Math.min(Math.round((nextDay - dayStart) / 3600000), 24);

  assert.strictEqual(out.daily.length, expectedSlots, 'every hour of the day has a slot');
  assert.deepStrictEqual(
    out.daily.map((d) => d.date),
    [...out.daily].sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.date),
    'slots stay in chronological order'
  );

  const filled = out.daily.find((d) => d.date.endsWith('T13'));
  assert.strictEqual(filled.filtered, 42, 'the 13:00 slot holds the fixture row');
  assert.strictEqual(filled.commands, 1);

  const empty = out.daily.find((d) => d.date.endsWith('T04'));
  assert.deepStrictEqual(
    { commands: empty.commands, raw: empty.raw, filtered: empty.filtered, keptOut: empty.keptOut },
    { commands: 0, raw: 0, filtered: 0, keptOut: 0 },
    'an hour with no commands is a real zero, not a missing bar'
  );
});

test('readRtkWindows returns one entry per range, exact to the second at the boundary', () => {
  const t = new Date('2026-09-04T16:15:00Z').getTime();
  const file = makeDb([
    { timestamp: utcStamp(new Date(t - 60_000)), input_tokens: 1000, output_tokens: 400 },
    { timestamp: utcStamp(new Date(t)), input_tokens: 1000, output_tokens: 100 }, // exactly at t: after
    { timestamp: utcStamp(new Date(t + 60_000)), input_tokens: 500, output_tokens: 100 },
  ]);
  const [before, after, empty] = readRtkWindows([[t - 3_600_000, t], [t, t + 3_600_000], [0, 1000]], file);
  assert.deepStrictEqual(before, { commands: 1, reachedPerCommand: 400, keptOutShare: 0.6 });
  assert.deepStrictEqual(after, { commands: 2, reachedPerCommand: 100, keptOutShare: 1300 / 1500 });
  assert.deepStrictEqual(empty, { commands: 0, reachedPerCommand: null, keptOutShare: null });
});

test('readRtkWindows runs one query however many windows it is asked for', (t) => {
  const t0 = new Date('2026-09-04T16:15:00Z').getTime();
  const file = makeDb([{ timestamp: utcStamp(new Date(t0)), input_tokens: 1000, output_tokens: 100 }]);
  // The statement class is not exported, so its prototype comes from a throwaway statement.
  const memory = new DatabaseSync(':memory:');
  const statementProto = Object.getPrototypeOf(memory.prepare('SELECT 1'));
  memory.close();
  const get = t.mock.method(statementProto, 'get');
  const all = t.mock.method(statementProto, 'all');
  const ranges = Array.from({ length: 50 }, (_, i) => [t0 - (i + 1) * 3_600_000, t0 + i * 3_600_000]);

  const out = readRtkWindows(ranges, file);

  assert.strictEqual(out.length, 50);
  assert.strictEqual(get.mock.callCount() + all.mock.callCount(), 1);
});

// The figures of one row as the SQL computes them. A 'rtk read' command is content, a
// 'rtk vitest' command is status and any other is 'other'. Every token count in the
// test rows is under the 7,500-token inline limit.
function expectedFigures(row) {
  if (row.rtk_cmd.startsWith('rtk read')) return { without: row.input_tokens, reached: row.output_tokens };
  if (row.rtk_cmd.startsWith('rtk vitest')) return { without: Math.min(row.input_tokens, 750), reached: row.output_tokens };
  return { without: row.input_tokens, reached: row.output_tokens };
}

// What readRtkWindows must return for one window, by filtering the rows in JavaScript.
function expectedWindow(rows, from, to) {
  const lo = new Date(from).toISOString().slice(0, 19);
  const hi = new Date(to).toISOString().slice(0, 19);
  const inside = rows.filter((r) => r.timestamp >= lo && r.timestamp < hi).map(expectedFigures);
  const reached = inside.reduce((sum, f) => sum + f.reached, 0);
  const without = inside.reduce((sum, f) => sum + f.without, 0);
  return {
    commands: inside.length,
    reachedPerCommand: inside.length ? reached / inside.length : null,
    keptOutShare: without ? (without - reached) / without : null,
  };
}

test('readRtkWindows matches a per-window filter for overlapping windows, mixed fraction widths and every command kind', () => {
  const t0 = new Date('2026-09-04T16:15:00Z').getTime();
  const rows = [
    { timestamp: '2026-09-04T16:14:59.999999+00:00', input_tokens: 900, output_tokens: 100 },
    { timestamp: '2026-09-04T16:14:59+00:00', input_tokens: 800, output_tokens: 80 },
    { timestamp: '2026-09-04T16:15:00+00:00', input_tokens: 700, output_tokens: 70 }, // the boundary second, no fraction
    { timestamp: '2026-09-04T16:15:00.123+00:00', input_tokens: 600, output_tokens: 60 }, // 3 digits
    { timestamp: '2026-09-04T16:15:00.123456+00:00', input_tokens: 500, output_tokens: 50, rtk_cmd: 'rtk read big.txt' }, // 6 digits
    { timestamp: '2026-09-04T16:15:01+00:00', input_tokens: 4000, output_tokens: 300, rtk_cmd: 'rtk vitest run' },
    { timestamp: '2026-09-04T17:15:00+00:00', input_tokens: 400, output_tokens: 40 }, // exactly the end of the hour
    { timestamp: '2026-09-04T17:15:00.5+00:00', input_tokens: 300, output_tokens: 30 },
    { timestamp: '2026-09-05T16:15:00+00:00', input_tokens: 200, output_tokens: 20 },
  ].map((r) => ({ rtk_cmd: 'rtk grep foo', ...r }));
  const file = makeDb(rows);
  const HOUR = 3_600_000;
  const ranges = [
    [t0 - HOUR, t0], [t0, t0 + HOUR], [t0 + HOUR, t0 + 2 * HOUR], // adjacent
    [t0 - HOUR, t0 + HOUR], [t0 - 2 * HOUR, t0 + 3 * HOUR], // overlapping the ones above
    [t0, t0 + 1000], [t0 + 500, t0 + 1500], // inside one second and straddling two
    [0, 1000], [t0 + 10 * 24 * HOUR, t0 + 11 * 24 * HOUR], // no rows
    [t0 + HOUR, t0], // from after to
  ];

  assert.deepStrictEqual(readRtkWindows(ranges, file), ranges.map(([from, to]) => expectedWindow(rows, from, to)));
});

test('readRtkWindows with no ranges returns an empty list for an rtk database', () => {
  const file = makeDb([{ timestamp: '2026-09-04T16:15:00+00:00' }]);
  assert.deepStrictEqual(readRtkWindows([], file), []);
});

test('readRtkWindows returns null when the database is missing or not rtk', () => {
  assert.strictEqual(readRtkWindows([[0, 1]], path.join(os.tmpdir(), 'no-such-rtk.db')), null);
  const junk = path.join(helpers.tmpDir(null, 'rtk'), 'junk.db');
  fs.writeFileSync(junk, 'not a database');
  assert.strictEqual(readRtkWindows([[0, 1]], junk), null);
});

test('readRtkDaily gives each local day its tokens reaching context per command and share kept out', () => {
  const day1 = new Date('2026-09-10T12:00:00'); // local noon
  const day2 = new Date('2026-09-11T12:00:00');
  const file = makeDb([
    { timestamp: utcStamp(day1), input_tokens: 1000, output_tokens: 400 },
    { timestamp: utcStamp(new Date(day1.getTime() + 3_600_000)), input_tokens: 1000, output_tokens: 200 },
    { timestamp: utcStamp(day2), input_tokens: 0, output_tokens: 0 }, // nothing without rtk: no share to compute
  ]);
  assert.deepStrictEqual(readRtkDaily(file), {
    reachedPerCommand: [
      { date: '2026-09-10', n: 2, value: 300 },
      { date: '2026-09-11', n: 1, value: 0 },
    ],
    keptOutShare: [{ date: '2026-09-10', n: 2, value: 0.7 }],
  });
});

test('readRtkDaily returns null when the database is missing or not rtk', () => {
  assert.strictEqual(readRtkDaily(path.join(os.tmpdir(), 'no-such-rtk.db')), null);
  const junk = path.join(helpers.tmpDir(null, 'rtk'), 'junk.db');
  fs.writeFileSync(junk, 'not a database');
  assert.strictEqual(readRtkDaily(junk), null);
});

test('day buckets run unbroken from the first day with rows to today', () => {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  threeDaysAgo.setHours(12, 0, 0, 0);
  const file = makeDb([{ timestamp: utcStamp(threeDaysAgo), saved_tokens: 42 }]);

  const out = readRtkUsage({ days: 7, dbPath: file });

  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const expected = [3, 2, 1, 0].map((n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return key(d);
  });
  assert.deepStrictEqual(out.daily.map((d) => d.date), expected);
  assert.deepStrictEqual(
    out.daily.slice(1).map((d) => [d.commands, d.raw, d.filtered, d.keptOut]),
    [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  );
});
