'use strict';

// Persists the rows lib/extract.js produces, so a restart does not re-read every
// transcript and the usage history outlives the transcripts Claude Code deletes
// after cleanupPeriodDays. The database is then the only copy of that history, so
// nothing here ever deletes, renames or recreates an existing database file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EXTRACT_VERSION } = require('./extract');

// node:sqlite loads without a flag from Node 22.13. package.json declares that floor,
// but npm only warns on an older Node, so a failed require here means "no
// persistence" and the server still starts. The same loading and warning handling
// as lib/rtk.js: only the one experimental-feature warning is dropped, and only
// around the require.
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

const SCHEMA_VERSION = 1;

// One JSON column per file: the aggregate step needs every row in JS for its dedupe
// sets and the tool join, and a file's rows are always written and replaced together.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    size INTEGER,
    mtime_ms REAL,
    version INTEGER,
    min_t INTEGER,
    max_t INTEGER,
    on_disk INTEGER,
    data TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function expandHome(p) {
  return p.replace(/^~/, os.homedir());
}

// The explicit TRANSCRIPTS_DB variable, then CLAUDE_CONFIG_DIR, then ~/.claude.
function getStorePath() {
  if (process.env.TRANSCRIPTS_DB) return expandHome(process.env.TRANSCRIPTS_DB);
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), 'cc-dashboard', 'transcripts.db');
  return path.join(os.homedir(), '.claude', 'cc-dashboard', 'transcripts.db');
}

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
 * Opens the database, creating it when missing. Returns null, after one warning,
 * when node:sqlite is missing or the file cannot be opened or was written by a newer
 * schema. The dashboard then runs without persistence.
 */
function openStore(dbPath = getStorePath()) {
  if (!DatabaseSync) {
    console.warn('[store] node:sqlite needs Node 22.13 or later, so usage history will not be kept past the transcripts on disk.');
    return null;
  }
  let db = null;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 2000;');
    // Read the schema version before creating anything, so a database written by a
    // newer schema is not given tables it does not use.
    const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const row = hasMeta ? db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() : undefined;
    if (row && Number(row.value) > SCHEMA_VERSION) {
      throw new Error(`the file uses schema ${row.value}, newer than this dashboard's ${SCHEMA_VERSION}`);
    }
    db.exec(SCHEMA);
    if (!row) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    return makeStore(db, dbPath);
  } catch (err) {
    console.warn(`[store] Could not open ${dbPath}, so usage history will not be kept: ${err.message}`);
    try {
      if (db) db.close();
    } catch {
      // already closed or never opened
    }
    return null;
  }
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, getStorePath, upgradeRows, openStore };
