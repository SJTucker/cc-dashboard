'use strict';

// Persists the rows lib/extract.js produces, so a restart does not re-read every
// transcript and the usage history outlives the transcripts Claude Code deletes
// after cleanupPeriodDays. The database is then the only copy of that history, so
// nothing here ever deletes, renames or recreates an existing database file.

const { EXTRACT_VERSION } = require('./extract');
const { SCHEMA_VERSION, getStorePath, openDatabase } = require('./db');

// Each function turns rows of version N into rows of version N + 1. Version 1 is the
// first, so the table is empty. A bump of EXTRACT_VERSION that changes the row shape
// adds `[oldVersion]: (rows) => newRows` here.
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

function makeStore(db, dbPath) {
  const selectAll = db.prepare('SELECT path, size, mtime_ms, version, min_t, max_t, on_disk, data FROM files');
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO files (path, size, mtime_ms, version, min_t, max_t, on_disk, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const gone = db.prepare('UPDATE files SET on_disk = 0 WHERE path = ?');
  // Set when the SELECT in loadAll fails. A broken store never writes into the damaged file.
  let broken = false;

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
    // Runs fn inside one transaction, so a refresh's writes land together or not at all.
    // On a broken store fn still runs, so callers' in-memory work proceeds, but its
    // put and markGone calls write nothing.
    transaction(fn) {
      if (broken) {
        fn();
        return;
      }
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}

/**
 * Opens the database for the row store. Returns null, after one warning, when the
 * file cannot be opened or was written by a newer schema. The dashboard then runs
 * without persistence. Reviews do not use this: lib/review-db.js lets the error out.
 */
function openStore(dbPath = getStorePath()) {
  let db = null;
  try {
    db = openDatabase(dbPath);
    return makeStore(db, dbPath);
  } catch (err) {
    console.warn(`[store] Could not open ${dbPath}, so usage history will not be kept: ${err.message}`);
    try {
      if (db) db.close();
    } catch {
      // already closed
    }
    return null;
  }
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, getStorePath, upgradeRows, openStore };
