'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { windowStart } = require('./window');

// node:sqlite landed in Node 22. package.json still declares a floor of >=18, so a
// failed require here means "no rtk panels", not a crashed server. Requiring it at
// module load keeps the per-request path free of try/catch.
// Requiring node:sqlite makes Node print "ExperimentalWarning: SQLite is an
// experimental feature" to stderr, which would land on top of server.js's three-line
// startup banner and read like a fault. Only that one warning is dropped, and only
// around the require - anything else Node wants to say still gets through, which
// --no-warnings would not allow. The API being flagged experimental is a real signal,
// but the cost of it changing here is bounded: the require fails and the rtk panels
// stop appearing.
let DatabaseSync = null;
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...rest);
};
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
} finally {
  process.emitWarning = emitWarning;
}

// rtk appends one row per hook-rewritten command to a live WAL-mode sqlite file.
// The default is the macOS location. RTK_DB overrides it, mirroring how
// CLAUDE_CONFIG_DIR overrides the projects directory in lib/scan.js. There is no
// platform-detection branch: Linux and Windows users set RTK_DB.
function getRtkDbPath() {
  if (process.env.RTK_DB) return process.env.RTK_DB.replace(/^~/, os.homedir());
  return path.join(os.homedir(), 'Library', 'Application Support', 'rtk', 'history.db');
}

const EMPTY = (dbPath) => ({
  meta: { dbPath, dbExists: false },
  summary: { totalCommands: 0, totalInput: 0, totalSaved: 0, savingsPct: 0 },
  daily: [],
  commands: [],
});

// rtk stores UTC ISO timestamps whose fractional-second part is VARIABLE width: on
// the reference database 21,879 rows carry 6 digits and 17 carry 3. Comparing a
// full-precision cutoff lexically against both widths misorders them, because '+'
// (0x2B) sorts below '0' (0x30). Slicing the cutoff to whole seconds sidesteps it:
// the first 19 characters are fixed-width, and a longer string sharing that prefix
// always sorts after the shorter one, so `timestamp >= '2026-09-23T00:00:00'` is
// exact to the second whatever the fraction. Comparing the bare column also keeps
// idx_timestamp usable - EXPLAIN QUERY PLAN reports a covering index search, and the
// result matches the slower datetime(timestamp) >= datetime(?) form row for row.
function cutoffFor(days) {
  const ms = windowStart(days);
  return ms == null ? null : new Date(ms).toISOString().slice(0, 19);
}

// rtk_cmd always starts 'rtk '. The subcommand is the next word, or the rest of the
// string when there is no next word ('rtk read'). instr() returns 0 on no match,
// which is why the CASE is needed rather than a bare instr()-1.
const SUBCOMMAND = `
  substr(rtk_cmd, 5,
    CASE WHEN instr(substr(rtk_cmd, 5), ' ') = 0
         THEN length(rtk_cmd)
         ELSE instr(substr(rtk_cmd, 5), ' ') - 1 END)`;

// How many detail rows to keep per command. Matches the slice in
// renderRtkCommands (public/app.js); anything beyond it is transferred and thrown
// away. A plain integer interpolated into SQL, never a caller-supplied value.
const DETAIL_LIMIT = 12;

// Mirrors the 24-slot fill in aggregate in lib/aggregate.js, for the same reason and with the same
// caveat. Without it the Today chart draws one full-width bar for a single busy
// hour, which reads as a whole day of activity, and the live poll re-widths every
// bar each time a new hour gets its first command. Hours with no commands render as
// real gaps instead.
//
// This is 24 slots on an ordinary day and 23 on the spring-forward day, where
// setHours(2) rolls to 3am because 2am does not exist locally. That is the day's
// real shape, so the key collision is the correct outcome rather than something to
// pad back to 24.
function fillHourAxis(daily) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const have = new Set(daily.map((d) => d.date));

  for (let h = 0; h < 24; h++) {
    const slot = new Date(midnight);
    slot.setHours(h);
    const m = String(slot.getMonth() + 1).padStart(2, '0');
    const day = String(slot.getDate()).padStart(2, '0');
    const hh = String(slot.getHours()).padStart(2, '0');
    const key = `${slot.getFullYear()}-${m}-${day}T${hh}`;
    if (have.has(key)) continue;
    have.add(key);
    daily.push({ date: key, commands: 0, input: 0, saved: 0 });
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));
}

// Day buckets run unbroken from the first day with rows to today, the same rule
// aggregate in lib/aggregate.js applies. Charts give each bucket the same width, so a
// missing idle day would squeeze the calendar. daily arrives sorted by date.
function fillDayAxis(daily) {
  if (!daily.length) return;
  const key = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = key(new Date());
  const have = new Set(daily.map((d) => d.date));
  const d = new Date(daily[0].date + 'T00:00:00'); // a date-time string without a zone parses as local time
  for (let k = daily[0].date; k <= today; d.setDate(d.getDate() + 1), k = key(d)) {
    if (!have.has(k)) daily.push({ date: k, commands: 0, input: 0, saved: 0 });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
}

function readRtkUsage({ days = 30, bucket = 'day' } = {}) {
  const dbPath = getRtkDbPath();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return EMPTY(dbPath);

  const cutoff = cutoffFor(days);
  const where = cutoff ? 'WHERE timestamp >= ?' : '';
  const args = cutoff ? [cutoff] : [];

  // SQLite parses rtk's '...+00:00' timestamps natively at either fraction width,
  // so 'localtime' converts them to the same local day keys localDateStr in lib/aggregate.js produces.
  const bucketExpr =
    bucket === 'hour'
      ? `strftime('%Y-%m-%dT%H', timestamp, 'localtime')`
      : `date(timestamp, 'localtime')`;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // Locked, or a WAL sidecar we cannot map. Not fatal.
    return EMPTY(dbPath);
  }

  try {
    const daily = db
      .prepare(
        `SELECT ${bucketExpr} AS date, COUNT(*) AS commands,
                SUM(input_tokens) AS input, SUM(saved_tokens) AS saved
         FROM commands ${where} GROUP BY date ORDER BY date`
      )
      .all(...args)
      .map((r) => ({ date: r.date, commands: r.commands, input: r.input, saved: r.saved }));

    if (bucket === 'hour') fillHourAxis(daily);
    else fillDayAxis(daily);

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(saved_tokens) AS saved
         FROM commands ${where}`
      )
      .get(...args);

    const byCommand = db
      .prepare(
        `SELECT ${SUBCOMMAND} AS name, COUNT(*) AS calls,
                SUM(input_tokens) AS input, SUM(saved_tokens) AS saved
         FROM commands ${where} GROUP BY name ORDER BY saved DESC`
      )
      .all(...args);

    // Capped in SQL, not in the browser. Uncapped, a 30-day read of the reference
    // database returned 8,209 detail rows and 1,075,342 bytes - 4,434 of those rows
    // for `grep` alone - to draw the 12 bars renderRtkCommands actually shows. The
    // rows are full shell command lines, so the payload is mostly text nothing
    // renders. DETAIL_LIMIT must stay >= the slice in renderRtkCommands.
    const byDetail = db
      .prepare(
        `SELECT parent, name, calls, saved FROM (
           SELECT ${SUBCOMMAND} AS parent, original_cmd AS name,
                  COUNT(*) AS calls, SUM(saved_tokens) AS saved,
                  ROW_NUMBER() OVER (
                    PARTITION BY ${SUBCOMMAND} ORDER BY SUM(saved_tokens) DESC, original_cmd
                  ) AS rn
           FROM commands ${where} GROUP BY parent, name
         ) WHERE rn <= ${DETAIL_LIMIT} ORDER BY saved DESC`
      )
      .all(...args);

    const details = new Map();
    for (const row of byDetail) {
      if (!details.has(row.parent)) details.set(row.parent, []);
      details.get(row.parent).push({ name: row.name, calls: row.calls, saved: row.saved });
    }

    const totalInput = totals.input || 0;
    const totalSaved = totals.saved || 0;

    return {
      meta: { dbPath, dbExists: true },
      summary: {
        totalCommands: totals.n || 0,
        totalInput,
        totalSaved,
        savingsPct: totalInput > 0 ? (totalSaved / totalInput) * 100 : 0,
      },
      daily,
      commands: byCommand.map((c) => ({
        name: c.name,
        calls: c.calls,
        input: c.input,
        saved: c.saved,
        details: details.get(c.name) || [],
      })),
    };
  } catch {
    // The file exists and opened, but is not an rtk database: junk bytes, a
    // different schema, or a corrupt page. sqlite validates lazily, so that only
    // surfaces here at the first statement - never at open - and without this the
    // route 500s with a stack trace on every request, which the 5s live poll on the
    // Today range then repeats forever.
    return EMPTY(dbPath);
  } finally {
    db.close();
  }
}

// Whole seconds, for the same reason cutoffFor slices: rtk's fraction width
// varies, and a 19-character bound compares exactly against both widths.
const toStamp = (ms) => new Date(ms).toISOString().slice(0, 19);

// The rtk rows of the before/after table. One open for every marker's two windows.
// A row stamped in the boundary second belongs to "after", matching the
// [from, to) windows in lib/efficiency.js.
function readRtkWindows(ranges) {
  const dbPath = getRtkDbPath();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const stmt = db.prepare(
      `SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(saved_tokens) AS saved
       FROM commands WHERE timestamp >= ? AND timestamp < ?`
    );
    return ranges.map(([from, to]) => {
      const row = stmt.get(toStamp(from), toStamp(to));
      const input = row.input || 0;
      const saved = row.saved || 0;
      return {
        commands: row.n,
        keptPerCommand: row.n ? (input - saved) / row.n : null,
        filteredShare: input ? saved / input : null,
      };
    });
  } catch {
    return null; // not an rtk database - see readRtkUsage
  } finally {
    db.close();
  }
}

// The two rtk rows of the before/after panel, one value per local day over all of
// rtk's history. Same formulas as readRtkWindows. Days with no commands are left
// out, not zero-filled as in readRtkUsage: the chart would draw a padded zero as a
// real day.
function readRtkDaily() {
  const dbPath = getRtkDbPath();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        `SELECT date(timestamp, 'localtime') AS date, COUNT(*) AS n,
                SUM(input_tokens) AS input, SUM(saved_tokens) AS saved
         FROM commands GROUP BY date ORDER BY date`
      )
      .all();
    return {
      keptPerCommand: rows.map((r) => ({ date: r.date, n: r.n, value: ((r.input || 0) - (r.saved || 0)) / r.n })),
      filteredShare: rows.filter((r) => r.input).map((r) => ({ date: r.date, n: r.n, value: r.saved / r.input })),
    };
  } catch {
    return null; // not an rtk database - see readRtkUsage
  } finally {
    db.close();
  }
}

module.exports = { getRtkDbPath, readRtkUsage, readRtkWindows, readRtkDaily };
