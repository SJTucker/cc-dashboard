'use strict';

// Persists the rows lib/extract.js produces, so a restart does not re-read every
// transcript and the usage history outlives the transcripts Claude Code deletes
// after cleanupPeriodDays. The database is then the only copy of that history, so
// nothing here ever deletes, renames or recreates an existing database file.

const { EXTRACT_VERSION } = require('./extract');
const { compactRows } = require('./compact-rows');
const { toolUseModels } = require('./tool-use-models');
const { repoFromProjectFolder, projectFolderOf } = require('./repo');
const { openDatabase, transaction: immediateTransaction } = require('./db');

// Each function turns rows of version N into rows of version N + 1. Version 1 is the
// first, so the table starts at 1. A bump of EXTRACT_VERSION that changes the row
// shape adds `[oldVersion]: (rows) => newRows` here.
//
// loadAll runs the chain on every row set, so lib/aggregate.js sees the current shape.
// An entry whose file is still on disk keeps the stored version, so isCurrent in
// lib/rowstore.js sees it as out of date and re-reads it. The stored row is never
// rewritten: the chain runs on each load.
//
// 1 to 2: version 2 added `commands`. A row set without it gets an empty list.
//
// 2 to 3: version 3 added `model` to each tool use row. The model is taken from the
// call at or before the tool use (lib/tool-use-models.js).
//
// 3 to 4: version 4 added `missReason` and `rebuild` to call rows. Both are written
// only where they apply, so a call without them is a valid version 4 call, and the
// step changes nothing. A call that did rebuild the prompt cache cannot be told
// apart from one that did not without the neighbouring calls' cache state, so no
// rebuild is added.
//
// 4 to 5: version 5 added `agentId` to subagent call rows, `noFinal` on responses
// that had no stop_reason, and step files. `noFinal` is written only where true, so
// a call without it is a valid version 5 call. Whether an old response had a final
// usage line is not recoverable from the row, so none is marked. The step changes
// nothing.
//
// 5 to 6: version 6 changed the key of a tool_use block without an id. The new keys
// (apiBlockIndex, else a per-response counter) cannot be rebuilt from stored rows, so
// the stored rows of a deleted transcript keep their old keys and the step changes
// nothing. A file still on disk is re-read, because its stored version is 5.
//
// 6 to 7 and 7 to 8 change nothing: absent recaps and prompt rows read as none.
//
// 8 to 9: version 9 added `results`, `turns` and `group` on Bash tool uses. Neither
// list can be rebuilt without the transcript, so a row set without them gets empty
// lists. A Bash tool use without `group` falls back to its detail in lib/fillers.js.
//
// 9 to 10: version 10 added `repo` to edit rows. A deleted transcript cannot be read
// again, so the step resolves the repo from the transcript's folder under projects/
// (repoFromProjectFolder in lib/repo.js) and gives it to every edit row without one.
// This is the one step that reads the file system, and it needs the stored path,
// which upgradeRows passes as the second argument.
//
// 10 to 11 changes nothing: version 11 leaves out edit rows for scratchpad, memory and
// global CLAUDE.md files. Stored edit rows carry no file path, so a deleted
// transcript's edits to those files stay counted, under No repo. A file still on disk
// is re-read, because its stored version is 10.
//
// 11 to 12 changes nothing: version 12 adds `handoffTitle` to a session. Stored rows
// keep no Read results, so a deleted transcript's session has no handoff title. A
// file still on disk is re-read, because its stored version is 11.
//
// Compaction (lib/compact-rows.js) drops `usage` keys the aggregate never reads from
// rows in memory. Stored rows keep the full `usage`. It needs no migration or version
// bump.
const MIGRATIONS = {
  1: (rows) => ({ ...rows, commands: Array.isArray(rows.commands) ? rows.commands : [] }),
  2: (rows) => {
    const models = toolUseModels(rows);
    return { ...rows, toolUses: rows.toolUses.map((use) => ({ ...use, model: models.get(use.key) ?? null })) };
  },
  3: (rows) => rows,
  4: (rows) => rows,
  5: (rows) => rows,
  6: (rows) => rows,
  7: (rows) => rows,
  8: (rows) => ({
    ...rows,
    results: Array.isArray(rows.results) ? rows.results : [],
    turns: Array.isArray(rows.turns) ? rows.turns : [],
  }),
  9: (rows, filePath) => {
    const edits = Array.isArray(rows.edits) ? rows.edits : [];
    if (!edits.some((e) => !('repo' in e))) return rows;
    const folder = projectFolderOf(filePath);
    const repo = folder ? repoFromProjectFolder(folder) : null;
    return { ...rows, edits: edits.map((e) => ('repo' in e ? e : { ...e, repo })) };
  },
  10: (rows) => rows,
  11: (rows) => rows,
  12: (rows) => rows,
  13: (rows) => rows,
};

// Walks `rows` up from `fromVersion` as far as the migrations reach. A missing
// migration leaves the rows at the version the chain reached.
function upgradeRows(rows, fromVersion, migrations = MIGRATIONS, filePath = null) {
  let version = fromVersion;
  let upgraded = rows;
  while (version < EXTRACT_VERSION && migrations[version]) {
    upgraded = migrations[version](upgraded, filePath);
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
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  return {
    // Every stored file as { path, size, mtimeMs, version, minT, maxT, onDisk, rows }.
    // Never throws. A failed SELECT returns [] and turns the store read-only-in-effect
    // (put, markGone and transaction do nothing). A row whose data is unparseable or
    // not a plain object, whose migration throws, or whose version is newer than
    // EXTRACT_VERSION is skipped with a warning and left in the database. `intern`
    // is the map compactRows shares strings through. The row store passes its own, so
    // loaded and newly read rows share one instance per value.
    loadAll(intern = new Map()) {
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
          // Every row set is migrated to the current shape. A file still on disk keeps its
          // stored version, so isCurrent in lib/rowstore.js fails and the file is read
          // again. Only isCurrent reads the version, and these entries are never written back.
          const upgraded = upgradeRows(rows, r.version, MIGRATIONS, r.path);
          compactRows(upgraded.rows, intern);
          entries.push({
            path: r.path,
            size: r.size,
            mtimeMs: r.mtime_ms,
            version: r.on_disk === 0 ? upgraded.version : r.version,
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
