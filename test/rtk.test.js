'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { getRtkDbPath, readRtkUsage } = require('../lib/rtk');

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
  assert.strictEqual(out.daily.length, 1);
  assert.match(out.daily[0].date, /^\d{4}-\d{2}-\d{2}T14$/);
  assert.strictEqual(out.daily[0].saved, 42);

  if (prev === undefined) delete process.env.RTK_DB;
  else process.env.RTK_DB = prev;
});
