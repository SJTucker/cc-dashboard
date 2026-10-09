'use strict';

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('./config-dir');
const { getStorePath, getServerDb, openDatabase, transaction } = require('./db');
const { SESSION_ID_PATTERN, REVIEW_FILE_PATTERN } = require('./session-id');
const { KINDS } = require('./review');

// Opens transcripts.db for reviews. bin/review-session opens its own handle through
// openReviewDb, which runs the import of the old review files on every open. The
// server uses getReviewDb, which runs it once per process. The import's meta key
// makes it copy the files once per database, whichever runs first.

const IMPORT_KEY = 'reviews_imported';
const STATUSES = ['pending', 'done', 'failed', 'skipped'];

// Where versions before the database kept one JSON file per review. Only the import
// reads this folder. Nothing writes to it any more, and the files are left on disk.
function legacyReviewsDir() {
  return path.join(getConfigDir(), 'cc-dashboard', 'reviews');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

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
function importReviewFiles(db, dir = legacyReviewsDir(), now = Date.now()) {
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
function openReviewDb(dbPath = getStorePath(), legacyDir = legacyReviewsDir()) {
  const db = openDatabase(dbPath);
  try {
    importReviewFiles(db, legacyDir);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// The server's handle for reviews: the getServerDb handle the row store also uses.
// The import runs on the first reviews request of the process. A failed import (the
// lock of bin/review-session, an unreadable file) throws and leaves `imported` false,
// so the next request tries again. The handle stays open either way, because only
// closeServerDb closes it.
let imported = false;
function getReviewDb() {
  const db = getServerDb();
  if (!imported) {
    importReviewFiles(db);
    imported = true;
  }
  return db;
}

module.exports = { IMPORT_KEY, legacyReviewsDir, importReviewFiles, openReviewDb, getReviewDb };
