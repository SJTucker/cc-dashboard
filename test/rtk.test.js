'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { getRtkDbPath, readRtkUsage, readRtkWindows } = require('../lib/rtk');

// Build a throwaway database with rtk's exact schema. Timestamps are written as
// UTC ISO strings with an explicit +00:00 offset, matching what rtk stores.
function makeDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-rtk-'));
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

test('getRtkDbPath honours RTK_DB and expands a leading tilde', () => {
  const prev = process.env.RTK_DB;
  try {
    process.env.RTK_DB = '/custom/history.db';
    assert.strictEqual(getRtkDbPath(), '/custom/history.db');

    process.env.RTK_DB = '~/rtk/history.db';
    assert.strictEqual(getRtkDbPath(), os.homedir() + '/rtk/history.db');
  } finally {
    if (prev === undefined) delete process.env.RTK_DB;
    else process.env.RTK_DB = prev;
  }
});

test('daily buckets use LOCAL dates, not the stored UTC date', () => {
  // 23:30 local today. In any timezone west of UTC this stores as tomorrow's UTC
  // date, so a substr(timestamp,1,10) implementation puts it on the wrong bar.
  const local = new Date();
  local.setHours(23, 30, 0, 0);

  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([{ timestamp: utcStamp(local), saved_tokens: 500, input_tokens: 800 }]);

  const out = readRtkUsage({ days: 7 });
  const expectedDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;

  assert.strictEqual(out.daily.length, 1);
  assert.strictEqual(out.daily[0].date, expectedDay, 'bucketed by local date');
  assert.strictEqual(out.daily[0].saved, 500);
  assert.strictEqual(out.daily[0].commands, 1);

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('commands are grouped by rtk subcommand with an original_cmd level below', () => {
  const now = new Date();
  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([
    { timestamp: utcStamp(now), rtk_cmd: 'rtk grep alpha', original_cmd: 'grep alpha', saved_tokens: 100, input_tokens: 200 },
    { timestamp: utcStamp(now), rtk_cmd: 'rtk grep beta', original_cmd: 'grep beta', saved_tokens: 50, input_tokens: 100 },
    { timestamp: utcStamp(now), rtk_cmd: 'rtk grep alpha', original_cmd: 'grep alpha', saved_tokens: 25, input_tokens: 75 },
    { timestamp: utcStamp(now), rtk_cmd: 'rtk read', original_cmd: 'cat x', saved_tokens: 900, input_tokens: 1000 },
  ]);

  const out = readRtkUsage({ days: 7 });

  assert.deepStrictEqual(
    out.commands.map((c) => [c.name, c.calls, c.saved]),
    [['read', 1, 900], ['grep', 3, 175]],
    'sorted by tokens saved, descending'
  );

  const grep = out.commands.find((c) => c.name === 'grep');
  assert.deepStrictEqual(
    grep.details.map((d) => [d.name, d.calls, d.saved]),
    [['grep alpha', 2, 125], ['grep beta', 1, 50]],
    'detail rows are distinct original_cmd values, saved-descending'
  );

  assert.strictEqual(out.summary.totalCommands, 4);
  assert.strictEqual(out.summary.totalSaved, 1075);
  assert.strictEqual(out.summary.totalInput, 1375);
  // 1075/1375 = 78.18%
  assert.ok(Math.abs(out.summary.savingsPct - 78.18) < 0.01);

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('a subcommand with no arguments still groups correctly', () => {
  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([
    { timestamp: utcStamp(new Date()), rtk_cmd: 'rtk read', original_cmd: 'cat a', saved_tokens: 10 },
  ]);
  const out = readRtkUsage({ days: 7 });
  assert.strictEqual(out.commands[0].name, 'read', 'no trailing space to trip the substr');
  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('a missing database returns an empty payload, not a throw', () => {
  const prev = process.env.RTK_DB;
  process.env.RTK_DB = path.join(os.tmpdir(), 'definitely-not-here', 'history.db');
  const out = readRtkUsage({ days: 7 });
  assert.strictEqual(out.meta.dbExists, false);
  assert.deepStrictEqual(out.daily, []);
  assert.deepStrictEqual(out.commands, []);
  assert.strictEqual(out.summary.totalCommands, 0);
  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('a range cutoff excludes older rows at either fractional-second width', () => {
  const now = Date.now();
  const recent = new Date(now - 2 * 86400000); // inside a 7-day window
  const old = new Date(now - 30 * 86400000); // outside it

  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([
    // 6-digit fraction, the common case
    { timestamp: recent.toISOString().replace('Z', '000+00:00'), saved_tokens: 7 },
    { timestamp: old.toISOString().replace('Z', '000+00:00'), saved_tokens: 999 },
    // 3-digit fraction, the 17-row minority on the reference database
    { timestamp: recent.toISOString().replace('Z', '+00:00'), saved_tokens: 3 },
    { timestamp: old.toISOString().replace('Z', '+00:00'), saved_tokens: 999 },
  ]);

  const windowed = readRtkUsage({ days: 7 });
  assert.strictEqual(windowed.summary.totalCommands, 2, 'both recent rows, neither old one');
  assert.strictEqual(windowed.summary.totalSaved, 10);

  const all = readRtkUsage({ days: null });
  assert.strictEqual(all.summary.totalCommands, 4, 'days:null reads the whole table');

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('hour bucketing produces the same key shape lib/scan.js uses', () => {
  const at14 = new Date();
  at14.setHours(14, 5, 0, 0);
  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([{ timestamp: utcStamp(at14), saved_tokens: 42 }]);

  const out = readRtkUsage({ days: 'today', bucket: 'hour' });
  // Length is the full-day axis, asserted by its own test; this one is about the
  // key shape, which has to match lib/scan.js so shortDate()/fullDate() parse it.
  const at14Bucket = out.daily.find((d) => d.saved === 42);
  assert.match(at14Bucket.date, /^\d{4}-\d{2}-\d{2}T14$/);

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('a file that exists but is not an rtk database degrades to an empty payload', () => {
  const prev = process.env.RTK_DB;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-rtk-bad-'));

  // Junk bytes: sqlite rejects this at the first statement, not at open.
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'this is definitely not a sqlite file\n');
  process.env.RTK_DB = junk;
  const fromJunk = readRtkUsage({ days: 7 });
  assert.strictEqual(fromJunk.meta.dbExists, false, 'junk file reports no usable database');
  assert.deepStrictEqual(fromJunk.daily, []);
  assert.strictEqual(fromJunk.summary.totalCommands, 0);

  // A real sqlite file that simply is not rtk's: opens fine, has no `commands`.
  const wrong = path.join(dir, 'wrong-schema.db');
  const other = new DatabaseSync(wrong);
  other.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
  other.close();
  process.env.RTK_DB = wrong;
  const fromWrong = readRtkUsage({ days: 7 });
  assert.strictEqual(fromWrong.meta.dbExists, false, 'wrong schema reports no usable database');
  assert.deepStrictEqual(fromWrong.commands, []);

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
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
    });
  }

  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb(rows);
  const out = readRtkUsage({ days: 7 });

  const grep = out.commands.find((c) => c.name === 'grep');
  assert.strictEqual(grep.calls, 20, 'the parent row still counts every call');
  assert.strictEqual(grep.saved, 210, 'and still sums every call');
  assert.strictEqual(grep.details.length, 12, 'but the detail level is capped');
  assert.strictEqual(grep.details[0].name, 'grep pattern-20', 'largest first');
  assert.strictEqual(grep.details[11].name, 'grep pattern-09', 'and the 12 largest are the ones kept');

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('the Today range gets a full-day hour axis, not just the hours with rows', () => {
  const at13 = new Date();
  at13.setHours(13, 20, 0, 0);
  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([{ timestamp: utcStamp(at13), saved_tokens: 42, input_tokens: 90 }]);

  const out = readRtkUsage({ days: 'today', bucket: 'hour' });

  // 23 on the spring-forward day, where 2am does not exist locally - the same
  // shape lib/scan.js produces, so the two Today charts share an axis.
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
  assert.strictEqual(filled.saved, 42, 'the 13:00 slot holds the fixture row');
  assert.strictEqual(filled.commands, 1);

  const empty = out.daily.find((d) => d.date.endsWith('T04'));
  assert.deepStrictEqual(
    { commands: empty.commands, input: empty.input, saved: empty.saved },
    { commands: 0, input: 0, saved: 0 },
    'an hour with no commands is a real zero, not a missing bar'
  );

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});

test('readRtkWindows returns one entry per range, exact to the second at the boundary', () => {
  const prev = process.env.RTK_DB;
  const t = new Date('2026-09-04T16:15:00Z').getTime();
  try {
    process.env.RTK_DB = makeDb([
      { timestamp: utcStamp(new Date(t - 60_000)), input_tokens: 1000, saved_tokens: 600 },
      { timestamp: utcStamp(new Date(t)), input_tokens: 1000, saved_tokens: 900 }, // exactly at t: after
      { timestamp: utcStamp(new Date(t + 60_000)), input_tokens: 500, saved_tokens: 400 },
    ]);
    const [before, after, empty] = readRtkWindows([[t - 3_600_000, t], [t, t + 3_600_000], [0, 1000]]);
    assert.deepStrictEqual(before, { commands: 1, keptPerCommand: 400, filteredShare: 0.6 });
    assert.deepStrictEqual(after, { commands: 2, keptPerCommand: 100, filteredShare: 1300 / 1500 });
    assert.deepStrictEqual(empty, { commands: 0, keptPerCommand: null, filteredShare: null });
  } finally {
    if (prev === undefined) delete process.env.RTK_DB;
    else process.env.RTK_DB = prev;
  }
});

test('readRtkWindows returns null when the database is missing or not rtk', () => {
  const prev = process.env.RTK_DB;
  try {
    process.env.RTK_DB = path.join(os.tmpdir(), 'no-such-rtk.db');
    assert.strictEqual(readRtkWindows([[0, 1]]), null);
    const junk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-rtk-')), 'junk.db');
    fs.writeFileSync(junk, 'not a database');
    process.env.RTK_DB = junk;
    assert.strictEqual(readRtkWindows([[0, 1]]), null);
  } finally {
    if (prev === undefined) delete process.env.RTK_DB;
    else process.env.RTK_DB = prev;
  }
});

test('day buckets run unbroken from the first day with rows to today', () => {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  threeDaysAgo.setHours(12, 0, 0, 0);
  const prev = process.env.RTK_DB;
  process.env.RTK_DB = makeDb([{ timestamp: utcStamp(threeDaysAgo), saved_tokens: 42 }]);

  const out = readRtkUsage({ days: 7 });

  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const expected = [3, 2, 1, 0].map((n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return key(d);
  });
  assert.deepStrictEqual(out.daily.map((d) => d.date), expected);
  assert.deepStrictEqual(
    out.daily.slice(1).map((d) => [d.commands, d.input, d.saved]),
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  );

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});
