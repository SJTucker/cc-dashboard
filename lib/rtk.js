'use strict';

const fs = require('fs');
const { windowStart, localDateStr, hourSlots } = require('./dates');

// node:sqlite comes through lib/sqlite.js, which drops the warning it prints on load.
const { DatabaseSync } = require('./sqlite');

const EMPTY = (dbPath) => ({
  meta: { dbPath, dbExists: false },
  summary: { totalCommands: 0, raw: 0, filtered: 0, keptOut: 0 },
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

// What a command put into the model's context without rtk and with it, in rtk's
// tokens (4 characters each). docs/research/2026-10-10-large-bash-output.md has
// the measurements behind every number here.

// Claude Code shows a Bash result inline up to 30,000 characters: 7,500 tokens.
const INLINE_LIMIT = 7500;
// A result over that limit is saved to a file or cut to an excerpt. The excerpt is
// 2,500 tokens, and saved results averaged 2,931 including later reads.
const OVERFLOW_TOKENS = 2500;
// The model narrows a test, type-check, lint or build run to a few hundred tokens
// whatever its size: a mean of 783 in transcripts and 670 in controlled runs.
const STATUS_TOKENS = 750;

// The model reads a file or a diff in full whether or not rtk filtered it, so
// these count their whole output on both sides. `rtk git diff` and `rtk git show`
// are matched on rtk_cmd, because their subcommand is `git`.
const CONTENT_SUBCOMMANDS = ['read', 'diff', 'log', 'json'];
const STATUS_SUBCOMMANDS = [
  'vitest', 'jest', 'test', 'err', 'cargo', 'tsc', 'lint', 'prettier', 'format', 'next',
  'playwright', 'pnpm', 'npm', 'npx', 'bun', 'bunx', 'dotnet', 'pytest', 'ruff', 'mypy',
  'rake', 'rspec', 'rubocop', 'phpunit', 'phpstan', 'pest', 'paratest', 'ecs', 'pint',
  'phpt', 'ctest', 'prisma',
];

// The lists above are constants, never request input, so quoting them into SQL is safe.
const sqlList = (names) => names.map((n) => `'${n}'`).join(', ');

// Every other subcommand, including any rtk adds later, is 'other'.
const KIND = `(CASE
  WHEN ${SUBCOMMAND} IN (${sqlList(CONTENT_SUBCOMMANDS)})
    OR rtk_cmd LIKE 'rtk git diff%' OR rtk_cmd LIKE 'rtk git show%' THEN 'content'
  WHEN ${SUBCOMMAND} IN (${sqlList(STATUS_SUBCOMMANDS)}) THEN 'status'
  ELSE 'other' END)`;

const capped = (col) => `(CASE WHEN ${col} <= ${INLINE_LIMIT} THEN ${col} ELSE ${OVERFLOW_TOKENS} END)`;

// Queries read FROM kindRows(...), which computes KIND once per row. Inlined into
// WITHOUT and WITH it ran twice per row and doubled the query time. The LIMIT stops
// SQLite flattening the subquery back into the outer query, which would re-inline KIND.
const kindRows = (where = '') => `(SELECT *, ${KIND} AS kind FROM commands ${where} LIMIT -1)`;

const WITHOUT = `(CASE kind
  WHEN 'content' THEN input_tokens
  WHEN 'status' THEN MIN(input_tokens, ${STATUS_TOKENS})
  ELSE ${capped('input_tokens')} END)`;
// Content commands count rtk's output in full. Any other rtk output goes through the
// same Bash tool, so the same limit applies to it.
const WITH = `(CASE kind WHEN 'content' THEN output_tokens ELSE ${capped('output_tokens')} END)`;
// Negative when rtk's output put more into context than the model would have taken.
const KEPT_OUT = `(${WITHOUT} - ${WITH})`;

// The three figures every readRtkUsage row carries.
const FIGURES = `SUM(input_tokens) AS raw, SUM(saved_tokens) AS filtered, SUM(${KEPT_OUT}) AS keptOut`;
const figures = (r) => ({ raw: r.raw || 0, filtered: r.filtered || 0, keptOut: r.keptOut || 0 });

// How many detail rows to keep per command. Equals DETAIL_LIMIT in
// public/constants.mjs, the number of rows the rtk panel draws; anything beyond it
// is transferred and thrown away. test/front-end-constants.test.js fails when the
// two differ. A plain integer interpolated into SQL, never a caller-supplied value.
const DETAIL_LIMIT = 12;

// Hour buckets fill the whole local day with the keys that aggregate (lib/aggregate.js)
// uses, so the rtk chart and the usage chart line up. hourSlots
// (lib/dates.js) explains the 23-key spring-forward day.
function fillHourAxis(daily, now = Date.now()) {
  const have = new Set(daily.map((d) => d.date));
  for (const key of hourSlots(windowStart('today', now))) {
    if (!have.has(key)) daily.push({ date: key, commands: 0, raw: 0, filtered: 0, keptOut: 0 });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
}

// Day buckets run unbroken from the first day with rows to today, the same rule
// aggregate in lib/aggregate.js applies. Charts give each bucket the same width, so a
// missing idle day would squeeze the calendar. daily arrives sorted by date.
function fillDayAxis(daily, now = Date.now()) {
  if (!daily.length) return;
  const today = localDateStr(new Date(now));
  const have = new Set(daily.map((d) => d.date));
  const d = new Date(daily[0].date + 'T00:00:00'); // a date-time string without a zone parses as local time
  for (let k = daily[0].date; k <= today; d.setDate(d.getDate() + 1), k = localDateStr(d)) {
    if (!have.has(k)) daily.push({ date: k, commands: 0, raw: 0, filtered: 0, keptOut: 0 });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
}

function readRtkUsage({ days = 30, bucket = 'day', dbPath } = {}) {
  if (!fs.existsSync(dbPath)) return EMPTY(dbPath);

  const cutoff = cutoffFor(days);
  const where = cutoff ? 'WHERE timestamp >= ?' : '';
  const args = cutoff ? [cutoff] : [];

  // SQLite parses rtk's '...+00:00' timestamps natively at either fraction width,
  // so 'localtime' converts them to the same local day keys localDateStr in lib/dates.js produces.
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
      .prepare(`SELECT ${bucketExpr} AS date, COUNT(*) AS commands, ${FIGURES}
                FROM ${kindRows(where)} GROUP BY date ORDER BY date`)
      .all(...args)
      .map((r) => ({ date: r.date, commands: r.commands, ...figures(r) }));

    if (bucket === 'hour') fillHourAxis(daily);
    else fillDayAxis(daily);

    const totals = db.prepare(`SELECT COUNT(*) AS n, ${FIGURES} FROM ${kindRows(where)}`).get(...args);

    const byCommand = db
      .prepare(`SELECT ${SUBCOMMAND} AS name, COUNT(*) AS calls, ${FIGURES}
                FROM ${kindRows(where)} GROUP BY name ORDER BY keptOut DESC`)
      .all(...args);

    // Capped in SQL, not in the browser. Uncapped, a 30-day read of the reference
    // database returned 8,209 detail rows and 1,075,342 bytes - 4,434 of those rows
    // for `grep` alone - to draw the 12 bars renderRtkCommands actually shows. The
    // rows are full shell command lines, so the payload is mostly text nothing
    // renders. DETAIL_LIMIT is the number of rows the rtk panel draws.
    // The cap ranks by magnitude so negative rows, which sort last, survive it.
    const byDetail = db
      .prepare(
        `SELECT parent, name, calls, raw, filtered, keptOut FROM (
           SELECT ${SUBCOMMAND} AS parent, original_cmd AS name, COUNT(*) AS calls, ${FIGURES},
                  ROW_NUMBER() OVER (
                    PARTITION BY ${SUBCOMMAND} ORDER BY ABS(SUM(${KEPT_OUT})) DESC, original_cmd
                  ) AS rn
           FROM ${kindRows(where)} GROUP BY parent, name
         ) WHERE rn <= ${DETAIL_LIMIT} ORDER BY keptOut DESC`
      )
      .all(...args);

    const details = new Map();
    for (const row of byDetail) {
      if (!details.has(row.parent)) details.set(row.parent, []);
      details.get(row.parent).push({ name: row.name, calls: row.calls, ...figures(row) });
    }

    return {
      meta: { dbPath, dbExists: true },
      summary: { totalCommands: totals.n || 0, ...figures(totals) },
      daily,
      commands: byCommand.map((c) => ({
        name: c.name,
        calls: c.calls,
        ...figures(c),
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

// The first index in `stamps`, which is sorted, that is at or after `stamp`. Both are
// strings. Comparing them as strings matches SQLite's BINARY collation, which orders
// the timestamp column the same way, so a row with a fraction lands on the same side
// of a whole-second bound as it does in `timestamp >= ?`.
function firstAtOrAfter(stamps, stamp) {
  let lo = 0;
  let hi = stamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (stamps[mid] < stamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The rtk rows of the before/after table. One open and one query for every marker's
// two windows: the rows from the earliest `from` to the latest `to` are read once in
// timestamp order, and each window is a difference of prefix sums between two binary
// searches. 132 windows used to be 132 full scans. A row stamped in the boundary
// second belongs to "after", matching the [from, to) windows in lib/efficiency.js.
function readRtkWindows(ranges, dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    // With no ranges the bounds are equal, so the query still runs (and still fails
    // on a database that is not rtk's) but returns no rows.
    const first = ranges.length ? toStamp(ranges.reduce((min, [from]) => Math.min(min, from), Infinity)) : '';
    const last = ranges.length ? toStamp(ranges.reduce((max, [, to]) => Math.max(max, to), -Infinity)) : '';
    const rows = db
      .prepare(
        `SELECT timestamp, ${WITH} AS reached, ${WITHOUT} AS without, ${KEPT_OUT} AS kept
         FROM ${kindRows('WHERE timestamp >= ? AND timestamp < ?')} ORDER BY timestamp`
      )
      .all(first, last);

    const stamps = rows.map((r) => r.timestamp);
    // Each array holds running totals: element k is the total of the first k rows.
    const reachedSums = [0];
    const withoutSums = [0];
    const keptSums = [0];
    for (const r of rows) {
      reachedSums.push(reachedSums[reachedSums.length - 1] + r.reached);
      withoutSums.push(withoutSums[withoutSums.length - 1] + r.without);
      keptSums.push(keptSums[keptSums.length - 1] + r.kept);
    }

    return ranges.map(([from, to]) => {
      const i = firstAtOrAfter(stamps, toStamp(from));
      const j = Math.max(i, firstAtOrAfter(stamps, toStamp(to)));
      const n = j - i;
      const without = withoutSums[j] - withoutSums[i];
      return {
        commands: n,
        reachedPerCommand: n ? (reachedSums[j] - reachedSums[i]) / n : null,
        keptOutShare: without ? (keptSums[j] - keptSums[i]) / without : null,
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
function readRtkDaily(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
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
                SUM(${WITH}) AS reached, SUM(${WITHOUT}) AS without, SUM(${KEPT_OUT}) AS kept
         FROM ${kindRows()} GROUP BY date ORDER BY date`
      )
      .all();
    return {
      reachedPerCommand: rows.map((r) => ({ date: r.date, n: r.n, value: (r.reached || 0) / r.n })),
      keptOutShare: rows.filter((r) => r.without).map((r) => ({ date: r.date, n: r.n, value: r.kept / r.without })),
    };
  } catch {
    return null; // not an rtk database - see readRtkUsage
  } finally {
    db.close();
  }
}

module.exports = { DETAIL_LIMIT, readRtkUsage, readRtkWindows, readRtkDaily, fillHourAxis };
