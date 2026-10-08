'use strict';

const fs = require('fs');
const { findJsonlFiles, getProjectsDir } = require('./scan');
const { EXTRACT_VERSION, extractFile } = require('./extract');
const { openStore } = require('./store');
const { windowStart } = require('./window');

// A refresh that finished this recently is reused. /api/summary?days=today and
// /api/sessions/live are requested together, and one stat pass serves both.
const REFRESH_SHARE_MS = 2000;

/**
 * Holds the extracted rows of every transcript in memory, keyed by path. A refresh
 * stats every transcript and reads again only the ones whose size or mtime changed.
 * Files last modified before today's local midnight are also written to `store`, so
 * a restart does not re-read them and their rows survive the transcript being
 * deleted. `store` may be null, which keeps everything in memory only.
 */
function createRowStore({ projectsDir = getProjectsDir, store = null, extract = extractFile, now = Date.now } = {}) {
  // path -> { path, size, mtimeMs, version, onDisk, persisted, stored, dbOnDisk, rows }
  // stored: the database has a row for this path. It never goes back to false.
  // persisted: that row matches the rows in memory.
  // dbOnDisk: the on_disk value the database holds, so a failed write is retried.
  const map = new Map();
  let order = []; // the on-disk paths of the last refresh, in walk order
  let generation = 0;
  let inflight = null;
  let finishedAt = null;

  if (store) {
    for (const stored of store.loadAll()) map.set(stored.path, { ...stored, persisted: true, stored: true, dbOnDisk: stored.onDisk });
  }

  // True when the stored rows still describe the file on disk.
  function isCurrent(entry, st) {
    return !!entry && entry.rows.ok && entry.size === st.size && entry.mtimeMs === st.mtimeMs && entry.version === EXTRACT_VERSION;
  }

  // Reads the file again when it is new, changed or extracted by an older extractor.
  // A failed read keeps the previous entry when there is one. Returns true when the
  // entry changed.
  async function load(file, st, previous) {
    if (isCurrent(previous, st)) {
      if (previous.onDisk) return false;
      // A transcript that was gone has come back.
      previous.onDisk = true;
      previous.persisted = false;
      return true;
    }
    const rows = await extract(file);
    if (!rows.ok && previous) {
      previous.onDisk = true;
      return false;
    }
    map.set(file, {
      path: file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      version: EXTRACT_VERSION,
      onDisk: true,
      persisted: false,
      stored: !!previous?.stored,
      dbOnDisk: !!previous?.dbOnDisk,
      rows,
    });
    return true;
  }

  // Writes the settled files, the stored files that vanished with newer rows than the
  // database holds (`gone`, written whatever their mtime, since a deleted file cannot
  // be written to), and marks the other vanished ones. A file modified before
  // today's midnight is not being written, so a half-finished response is never
  // stored and the 5 s poll writes nothing. One transaction per refresh. A failed
  // write leaves the entries unpersisted, so the next refresh retries.
  function persist(settled, gone, vanished) {
    if (!store || (!settled.length && !gone.length && !vanished.length)) return;
    try {
      store.transaction(() => {
        for (const entry of settled) store.put(entry.path, entry);
        for (const entry of gone) store.put(entry.path, entry);
        for (const entry of vanished) store.markGone(entry.path);
      });
      for (const entry of [...settled, ...gone]) {
        entry.persisted = true;
        entry.stored = true;
        entry.dbOnDisk = entry.onDisk;
      }
      for (const entry of vanished) entry.dbOnDisk = false;
    } catch (err) {
      console.warn(`[store] Could not write transcript rows, will retry on the next refresh: ${err.message}`);
    }
  }

  // True when the projects root exists but cannot be listed (EACCES, EMFILE).
  // findJsonlFiles returns [] for that root, which run() would read as every
  // transcript being deleted.
  function rootUnreadable() {
    const root = projectsDir();
    if (!fs.existsSync(root)) return false;
    try {
      fs.readdirSync(root);
      return false;
    } catch {
      return true;
    }
  }

  async function run() {
    if (rootUnreadable()) return; // keep the map, order and generation as they were
    const midnight = windowStart('today', now());
    let changed = false;
    const walk = [];
    for (const file of findJsonlFiles(projectsDir())) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue; // vanished since the directory walk
      }
      if (await load(file, st, map.get(file))) changed = true;
      walk.push(file);
    }

    const present = new Set(walk);
    const gone = [];
    const vanished = [];
    for (const [filePath, entry] of map) {
      if (present.has(filePath)) continue;
      if (!entry.stored) {
        map.delete(filePath); // never stored, so there is nothing to keep
        changed = true;
        continue;
      }
      if (entry.onDisk) {
        entry.onDisk = false;
        changed = true;
      }
      // Anything the database does not yet say about this entry is retried each refresh.
      if (!entry.persisted) gone.push(entry);
      else if (entry.dbOnDisk) vanished.push(entry);
    }

    const settled = walk.map((file) => map.get(file)).filter((e) => !e.persisted && e.rows.ok && e.mtimeMs < midnight);
    persist(settled, gone, vanished);

    order = walk;
    if (changed) generation += 1;
  }

  return {
    // Concurrent callers share one run, and a run that finished under 2 s ago is reused.
    refresh() {
      if (inflight) return inflight;
      if (finishedAt !== null && now() - finishedAt < REFRESH_SHARE_MS) return Promise.resolve();
      inflight = run()
        .then(() => {
          finishedAt = now();
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    // Retained entries whose transcript is gone come first, sorted by path, then the
    // files on disk in walk order. Walk order decides which duplicate row wins and
    // which session title is last, so it matches the order lib/scan.js reads in.
    entries() {
      const onDisk = new Set(order);
      const retained = [...map.values()].filter((e) => !onDisk.has(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
      return [...retained, ...order.map((p) => map.get(p))];
    },
    get generation() {
      return generation;
    },
  };
}

let shared = null;

// The row store the server uses, opened on first use so CLAUDE_CONFIG_DIR and
// TRANSCRIPTS_DB are read when the server starts rather than when this file loads.
function getRowStore() {
  if (!shared) shared = createRowStore({ store: openStore() });
  return shared;
}

module.exports = { REFRESH_SHARE_MS, createRowStore, getRowStore };
