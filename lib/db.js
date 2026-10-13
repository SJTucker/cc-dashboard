'use strict';

// The one opener for cc-dashboard/transcripts.db. The row store (lib/store.js), the
// reviews (lib/review-db.js) and bin/review-session all open through here, so the
// schema, the journal mode and the busy timeouts are defined once. In the server the
// row store and the reviews share one handle from createServerDb. This module requires
// nothing from lib/extract.js or lib/rowstore.js, so bin/review-session can load it
// without the row store.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('./sqlite');

// 1: the files and meta tables. 2: adds reviews and suggestions. 3: adds 'duplicate'
// to suggestions.reason. CREATE TABLE IF NOT EXISTS adds missing tables to an older
// file, upgradeReasons rebuilds a v2 suggestions table, and openDatabase then stamps
// 3. A checkout that only knows an older schema refuses a newer file instead of
// misreading it.
const SCHEMA_VERSION = 3;
// The reasons a dismissed suggestion can carry. lib/review.js re-exports the list for
// the server and the panel.
const DISMISS_REASONS = ['done', 'not_useful', 'duplicate'];
// bin/review-session waits up to 5 s for the write lock. It is a separate process
// with no requests to hold up.
const BUSY_TIMEOUT_MS = 5000;
// The server waits at most 250 ms. node:sqlite waits synchronously, so no other
// request is answered while the server waits. A server write that meets the lock
// fails with SQLITE_BUSY instead, and each such write has a retry or an error answer
// (see isBusy).
const SERVER_BUSY_TIMEOUT_MS = 250;

// One definition for the live table and for the copy upgradeReasons builds.
function suggestionsTable(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    session_id TEXT NOT NULL,
    idx INTEGER NOT NULL CHECK (idx >= 0),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    dismissed_at INTEGER,
    reason TEXT CHECK (reason IN (${DISMISS_REASONS.map((r) => `'${r}'`).join(', ')})),
    CHECK ((dismissed_at IS NULL) = (reason IS NULL)),
    PRIMARY KEY (session_id, idx)
  );`;
}

// files: one JSON column per file, because the aggregate step needs every row in JS
// for its dedupe sets and the tool join, and a file's rows are written together.
// reviews and suggestions: see lib/review.js. skip_reason is the "reason" a skipped
// review file held. suggestions.reason is the dismissal reason.
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
  CREATE TABLE IF NOT EXISTS reviews (
    session_id TEXT PRIMARY KEY,
    project TEXT,
    ended_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
    claimed_at INTEGER,
    reviewed_at INTEGER,
    transcript TEXT,
    title TEXT,
    branch TEXT,
    skip_reason TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS reviews_reviewed_at ON reviews (reviewed_at);
  ${suggestionsTable('suggestions')}
`;

function getStorePath(configDir) {
  return path.join(configDir, 'cc-dashboard', 'transcripts.db');
}

/**
 * Opens the database, creating it when missing. Throws, after closing the handle,
 * when the file cannot be opened or was written by a newer schema. The version is
 * read before anything else is written, so a newer file is left byte for byte as it
 * was. WAL lets the server read while review-session processes write. A WAL file
 * keeps its mode, so the pragma is a no-op after the first open.
 */
function openDatabase(dbPath, { busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  // The value is interpolated into a PRAGMA, so only a whole number gets that far.
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError(`busyTimeoutMs must be a whole number of milliseconds, not ${String(busyTimeoutMs)}`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const row = hasMeta ? db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() : undefined;
    if (row && Number(row.value) > SCHEMA_VERSION) {
      throw new Error(`the file uses schema ${row.value}, newer than this dashboard's ${SCHEMA_VERSION}`);
    }
    db.exec('PRAGMA journal_mode = WAL;');
    if (row && Number(row.value) === 2) upgradeReasons(db);
    db.exec(SCHEMA);
    if (!row || Number(row.value) < SCHEMA_VERSION) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    }
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // already closed
    }
    throw err;
  }
}

// SQLite cannot change a CHECK constraint in place, so a v2 suggestions table is
// copied into one with the v3 reason list. The version is read again under the write
// lock, so a second process that waited for the lock finds 3 and skips the copy.
function upgradeReasons(db) {
  transaction(db, () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (Number(row?.value) !== 2) return;
    db.exec(suggestionsTable('suggestions_v3'));
    db.exec('INSERT INTO suggestions_v3 (session_id, idx, kind, text, dismissed_at, reason) SELECT session_id, idx, kind, text, dismissed_at, reason FROM suggestions');
    db.exec('DROP TABLE suggestions');
    db.exec('ALTER TABLE suggestions_v3 RENAME TO suggestions');
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(SCHEMA_VERSION));
  });
}

// Runs fn inside BEGIN IMMEDIATE, so the write lock is taken first and waits out the
// busy timeout once. Returns fn's value. A throw rolls back and rethrows. If the
// ROLLBACK itself fails, the error from fn is still the one thrown.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the transaction is already closed; the error from fn matters more
    }
    throw err;
  }
}

// The server's handle on transcripts.db, shared by the row store (lib/rowstore.js)
// and the reviews (lib/review-db.js). get() opens it on first use with the 250 ms
// busy timeout. A failed open throws and is not kept, so the next call tries again.
// close() closes it and forgets it. Closing the last connection checkpoints the WAL
// into transcripts.db and removes transcripts.db-wal. close() does nothing when no
// handle is open.
function createServerDb(dbPath) {
  let db = null;
  return {
    get() {
      if (!db) db = openDatabase(dbPath, { busyTimeoutMs: SERVER_BUSY_TIMEOUT_MS });
      return db;
    },
    close() {
      if (!db) return;
      const open = db;
      db = null;
      open.close();
    },
  };
}

// True for SQLITE_BUSY: another connection held the write lock past the busy
// timeout. node:sqlite puts the SQLite result code on err.errcode. On Node 22.23
// (2026-10-08) a locked write gave errcode 5 and errstr 'database is locked'. The
// low byte is compared, so the extended codes SQLITE_BUSY_RECOVERY (261) and
// SQLITE_BUSY_SNAPSHOT (517) count too.
function isBusy(err) {
  return typeof err?.errcode === 'number' && (err.errcode & 0xff) === 5;
}

module.exports = {
  SCHEMA_VERSION, BUSY_TIMEOUT_MS, SERVER_BUSY_TIMEOUT_MS, DISMISS_REASONS,
  getStorePath, openDatabase, transaction, createServerDb, isBusy,
};
