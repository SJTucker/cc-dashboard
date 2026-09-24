'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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
  if (days == null) return null;
  let ms;
  if (days === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    ms = d.getTime();
  } else {
    ms = Date.now() - days * 24 * 60 * 60 * 1000;
  }
  return new Date(ms).toISOString().slice(0, 19);
}

// rtk_cmd always starts 'rtk '. The subcommand is the next word, or the rest of the
// string when there is no next word ('rtk read'). instr() returns 0 on no match,
// which is why the CASE is needed rather than a bare instr()-1.
const SUBCOMMAND = `
  substr(rtk_cmd, 5,
    CASE WHEN instr(substr(rtk_cmd, 5), ' ') = 0
         THEN length(rtk_cmd)
         ELSE instr(substr(rtk_cmd, 5), ' ') - 1 END)`;

function readRtkUsage({ days = 30, bucket = 'day' } = {}) {
  const dbPath = getRtkDbPath();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return EMPTY(dbPath);

  const cutoff = cutoffFor(days);
  const where = cutoff ? 'WHERE timestamp >= ?' : '';
  const args = cutoff ? [cutoff] : [];

  // SQLite parses rtk's '...+00:00' timestamps natively at either fraction width,
  // so 'localtime' converts them to the same local day keys lib/scan.js produces.
  const bucketExpr =
    bucket === 'hour'
      ? `strftime('%Y-%m-%dT%H', timestamp, 'localtime')`
      : `date(timestamp, 'localtime')`;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // Locked, corrupt, or a WAL sidecar we cannot map. Not fatal.
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

    const byDetail = db
      .prepare(
        `SELECT ${SUBCOMMAND} AS parent, original_cmd AS name,
                COUNT(*) AS calls, SUM(saved_tokens) AS saved
         FROM commands ${where} GROUP BY parent, name ORDER BY saved DESC`
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
  } finally {
    db.close();
  }
}

module.exports = { getRtkDbPath, readRtkUsage };
