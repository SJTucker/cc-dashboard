'use strict';

const fs = require('fs');
const path = require('path');
const { openDatabase, transaction } = require('./db');
const { SESSION_ID_PATTERN, REVIEW_FILE_PATTERN } = require('./session-id');
const { KINDS } = require('./review');
const { readJson } = require('./files');

// Opens transcripts.db for reviews. bin/review-session opens its own handle through
// openReviewDb, which runs the import of the old review files on every open. The
// server uses createReviewDbGetter, which runs it once per server. The import's meta key
// makes it copy the files once per database, whichever runs first.

const IMPORT_KEY = 'reviews_imported';
const STATUSES = ['pending', 'done', 'failed', 'skipped'];

// Where versions before the database kept one JSON file per review. Only the import
// reads this folder. Nothing writes to it any more, and the files are left on disk.
function legacyReviewsDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'reviews');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);

// Inserts one review file's record. INSERT OR IGNORE leaves a row that exists alone.
function importOne(db, name, r) {
  const sessionId = typeof r?.sessionId === 'string' ? r.sessionId : name.replace(/\.json$/, '');
  if (!SESSION_ID_PATTERN.test(sessionId) || !STATUSES.includes(r.status)) return 0;
  const res = db.prepare(
    `INSERT OR IGNORE INTO reviews
       (session_id, project, ended_at, status, claimed_at, reviewed_at, transcript, title, branch, skip_reason, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, str(r.project), num(r.endedAt), r.status, num(r.claimedAt), num(r.reviewedAt), str(r.transcript), str(r.title), str(r.branch), str(r.reason), str(r.error));
  if (res.changes !== 1) return 0;
  const suggestions = Array.isArray(r.suggestions) ? r.suggestions.filter((s) => s && KINDS.includes(s.kind) && typeof s.text === 'string') : [];
  const insert = db.prepare('INSERT INTO suggestions (session_id, idx, kind, text) VALUES (?, ?, ?, ?)');
  suggestions.forEach((s, i) => insert.run(sessionId, i, s.kind, s.text));
  return 1;
}

// Copies every review file in `dir` into the tables, once. The meta key is checked
// and written inside the same BEGIN IMMEDIATE transaction as the inserts, so two
// processes opening at once import once. Returns the number of reviews inserted.
function importReviewFiles(db, dir, now = Date.now()) {
  return transaction(db, () => {
    if (db.prepare('SELECT 1 AS x FROM meta WHERE key = ?').get(IMPORT_KEY)) return 0;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // no folder: nothing to import
    }
    let imported = 0;
    for (const name of names) {
      if (!REVIEW_FILE_PATTERN.test(name)) continue;
      const r = readJson(path.join(dir, name));
      if (r && typeof r === 'object') imported += importOne(db, name, r);
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(IMPORT_KEY, String(now));
    return imported;
  });
}

// Throws when the database cannot be opened, so callers report it.
function openReviewDb(dbPath, legacyDir) {
  const db = openDatabase(dbPath);
  try {
    importReviewFiles(db, legacyDir);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// The server's reviews handle. getDb is the get of createServerDb, which the row
// store shares. The import of the old review files in legacyDir runs on the first
// call. A failed import (the lock of bin/review-session, an unreadable file) throws
// and leaves the flag unset, so the next call tries again. The handle stays open
// either way: only the server's close closes it.
function createReviewDbGetter(getDb, legacyDir) {
  let imported = false;
  return function getReviewDb() {
    const db = getDb();
    if (!imported) {
      importReviewFiles(db, legacyDir);
      imported = true;
    }
    return db;
  };
}

module.exports = { IMPORT_KEY, legacyReviewsDir, importReviewFiles, openReviewDb, createReviewDbGetter };
