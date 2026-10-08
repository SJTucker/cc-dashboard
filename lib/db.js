'use strict';

// The one opener for cc-dashboard/transcripts.db. The row store (lib/store.js), the
// reviews (lib/review-db.js) and bin/review-session all open through here, so the
// schema, the journal mode and the busy timeout are defined once. This module
// requires nothing from lib/extract.js or lib/rowstore.js, so bin/review-session can
// load it without the row store.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('./config-dir');
const { DatabaseSync } = require('./sqlite');

// 1: the files and meta tables. 2: adds reviews and suggestions. CREATE TABLE IF NOT
// EXISTS adds the new tables to a v1 file, and openDatabase then stamps 2. A checkout
// that only knows schema 1 refuses a file stamped 2 instead of ignoring its reviews.
const SCHEMA_VERSION = 2;
const BUSY_TIMEOUT_MS = 5000;

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
  CREATE TABLE IF NOT EXISTS suggestions (
    session_id TEXT NOT NULL,
    idx INTEGER NOT NULL CHECK (idx >= 0),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    dismissed_at INTEGER,
    reason TEXT CHECK (reason IN ('done', 'not_useful')),
    CHECK ((dismissed_at IS NULL) = (reason IS NULL)),
    PRIMARY KEY (session_id, idx)
  );
`;

function getStorePath() {
  return path.join(getConfigDir(), 'cc-dashboard', 'transcripts.db');
}

/**
 * Opens the database, creating it when missing. Throws, after closing the handle,
 * when the file cannot be opened or was written by a newer schema. The version is
 * read before anything else is written, so a newer file is left byte for byte as it
 * was. WAL lets the server read while review-session processes write. A WAL file
 * keeps its mode, so the pragma is a no-op after the first open.
 */
function openDatabase(dbPath = getStorePath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const row = hasMeta ? db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() : undefined;
    if (row && Number(row.value) > SCHEMA_VERSION) {
      throw new Error(`the file uses schema ${row.value}, newer than this dashboard's ${SCHEMA_VERSION}`);
    }
    db.exec('PRAGMA journal_mode = WAL;');
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

module.exports = { SCHEMA_VERSION, BUSY_TIMEOUT_MS, getStorePath, openDatabase, transaction };
