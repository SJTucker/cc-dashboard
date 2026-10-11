'use strict';

// Persists the rows lib/extract.js produces, so a restart does not re-read every
// transcript and the usage history outlives the transcripts Claude Code deletes
// after cleanupPeriodDays. The database is then the only copy of that history, so
// nothing here ever deletes, renames or recreates an existing database file.

const { EXTRACT_VERSION } = require('./extract');
const { compactRows } = require('./compact-rows');
const { openDatabase, transaction: immediateTransaction } = require('./db');

// Each function turns rows of version N into rows of version N + 1. Version 1 is the
// first, so the table is empty. A bump of EXTRACT_VERSION that changes the row shape
// adds `[oldVersion]: (rows) => newRows` here.
//
// Version 2 added `commands` and has no migration. A migration would bring a file
// still on disk up to EXTRACT_VERSION, so isCurrent in lib/rowstore.js would never
// read it again for its command rows. Rows of a deleted transcript stay at version 1
// with no `commands`, which lib/aggregate.js counts as none.
//
// Version 3 added `model` to tool use rows and has no migration, for the same
// reason. Rows of a deleted transcript keep tool uses with no `model`, and
// lib/aggregate.js gives each the model of the call before it.
//
// Version 4 added `missReason` (only where Claude Code gave one) and `rebuild` to call rows and has no migration, for
// the same reason. Rows of a deleted transcript have no `rebuild`, which counts as no
// rebuilds.
//
// Compaction (lib/compact-rows.js) drops `usage` keys the aggregate never reads from
// rows in memory. Stored rows keep the full `usage`. It needs no migration or version
// bump.
const MIGRATIONS = {};

// Walks `rows` up from `fromVersion` as far as the migrations reach. A file still on
// disk with a version short of EXTRACT_VERSION is re-extracted by lib/rowstore.js,
// so a missing migration only matters for rows whose transcript is gone, and those
// stay at the version the chain reached.
function upgradeRows(rows, fromVersion, migrations = MIGRATIONS) {
  let version = fromVersion;
  let upgraded = rows;
  while (version < EXTRACT_VERSION && migrations[version]) {
    upgraded = migrations[version](upgraded);
    version += 1;
  }
  return { rows: upgraded, version };
}

function makeStore(db, dbPath, ownsDb) {
  const selectAll = db.prepare('SELECT path, size, mtime_ms, version, min_t, max_t, on_disk, data FROM files');
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO files (path, size, mtime_ms, version, min_t, max_t, on_disk, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const gone = db.prepare('UPDATE files SET on_disk = 0 WHERE path = ?');
  // Set when the SELECT in loadAll fails. A broken store never writes into the damaged file.
  let broken = false;
  // Shares one string instance per repeated value across every file loadAll returns.
  const intern = new Map();

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  return {
    // Every stored file as { path, size, mtimeMs, version, minT, maxT, onDisk, rows }.
    // Never throws. A failed SELECT returns [] and turns the store read-only-in-effect
    // (put, markGone and transaction do nothing). A row whose data is unparseable or
    // not a plain object, whose migration throws, or whose version is newer than
    // EXTRACT_VERSION is skipped with a warning and left in the database.
    loadAll() {
      let all;
      try {
        all = selectAll.all();
      } catch (err) {
        broken = true;
        console.warn(`[store] Could not read ${dbPath}, so usage history will not be kept: ${err.message}`);
        return [];
      }
      const entries = [];
      for (const r of all) {
        try {
          if (r.version > EXTRACT_VERSION) throw new Error(`version ${r.version} is newer than ${EXTRACT_VERSION}`);
          const rows = JSON.parse(r.data);
          if (!isPlainObject(rows)) throw new Error('data is not an object');
          const upgraded = upgradeRows(rows, r.version);
          compactRows(upgraded.rows, intern);
          entries.push({
            path: r.path,
            size: r.size,
            mtimeMs: r.mtime_ms,
            version: upgraded.version,
            minT: r.min_t,
            maxT: r.max_t,
            onDisk: r.on_disk === 1,
            rows: upgraded.rows,
          });
        } catch (err) {
          console.warn(`[store] Skipping the stored rows for ${r.path}: ${err.message}`);
        }
      }
      return entries;
    },
    // Replaces the path's row in one statement.
    put(filePath, entry) {
      if (broken) return;
      upsert.run(filePath, entry.size, entry.mtimeMs, entry.version, entry.rows.minT, entry.rows.maxT, entry.onDisk ? 1 : 0, JSON.stringify(entry.rows));
    },
    markGone(filePath) {
      if (broken) return;
      gone.run(filePath);
    },
    // Runs fn inside BEGIN IMMEDIATE (transaction in lib/db.js), so the write lock is
    // taken before fn runs and a refresh's writes land together or not at all. A lock
    // that outlasts the busy timeout throws before fn runs. On a broken store fn still
    // runs, so callers' in-memory work proceeds, but its put and markGone calls write
    // nothing.
    transaction(fn) {
      if (broken) {
        fn();
        return;
      }
      immediateTransaction(db, fn);
    },
    // Closes the handle only when the store opened it. A handle from getDb belongs to
    // the caller, and for the server only the close of createServerDb closes it.
    close() {
      if (ownsDb) db.close();
    },
  };
}

/**
 * Opens the database for the row store. Returns null, after one warning, when the
 * file cannot be opened or was written by a newer schema. The dashboard then runs
 * without persistence. Reviews do not use this: lib/review-db.js lets the error out.
 * `getDb` returns the handle to use. Without it openStore opens its own handle and
 * closes it on a failure. A handle from getDb belongs to the caller and is never
 * closed here: the server passes the get of createServerDb, whose handle only its close closes.
 */
function openStore(dbPath, getDb = null) {
  let db = null;
  try {
    db = getDb ? getDb() : openDatabase(dbPath);
    return makeStore(db, dbPath, !getDb);
  } catch (err) {
    console.warn(`[store] Could not open ${dbPath}, so usage history will not be kept: ${err.message}`);
    try {
      if (db && !getDb) db.close();
    } catch {
      // already closed
    }
    return null;
  }
}

module.exports = { MIGRATIONS, upgradeRows, openStore };
