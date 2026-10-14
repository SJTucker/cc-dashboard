'use strict';

const fs = require('fs');
const path = require('path');
const { findJsonlFiles } = require('./transcript-files');
const { findStepFiles } = require('./agent-steps');
const { EXTRACT_VERSION, extractFile } = require('./extract');
const { isBusy } = require('./db');
const { compactRows } = require('./compact-rows');
const { windowStart } = require('./dates');
const { withPool, poolSize, failedRows } = require('./extract-pool');

// A refresh that finished this recently is reused. /api/summary?days=today and
// /api/sessions/live are requested together, and one stat pass serves both.
const REFRESH_SHARE_MS = 2000;

// A run reads on worker threads only when more than this many files are out of date
// and they total more than this many bytes. The 5 s poll re-reads every live
// transcript whole when it grows, so a heavy day can pass the byte limit with a
// dozen live files. The file count keeps that from starting and closing a pool every
// 5 s. A new database or a change to EXTRACT_VERSION passes both limits.
const POOL_MIN_FILES = 32;
const POOL_MIN_BYTES = 64 * 1024 * 1024;

// A step file (lib/agent-steps.js) not written for this long belongs to a subagent
// that has finished. Once the database holds its rows, the file is deleted.
const STEP_FILE_KEEP_MS = 24 * 60 * 60 * 1000;

// "1.8 GB", "23 MB", "412 KB" or "90 B", for the startup line.
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// "5.4 s" or "70 ms".
function formatElapsed(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * Holds the extracted rows of every transcript in memory, keyed by path. A refresh
 * stats every transcript and reads again only the ones whose size or mtime changed.
 * Files last modified before today's local midnight are also written to `store`, so
 * a restart does not re-read them and their rows survive the transcript being
 * deleted. `store` may be null, which keeps everything in memory only.
 */
function createRowStore({
  projectsDir,
  // The folder of the mod's step files, or null for none. Its *.json files are read
  // like transcripts, into row sets with agentSteps.
  agentUsageDir = () => null,
  store = null,
  // Reads one transcript. A test that injects it gets no worker pool, so it sees every call.
  extract = null,
  // Runs fn(pool) with a pool of `size` workers and closes the pool afterwards. A test
  // injects a fake to control when each file finishes.
  openPool = extract ? null : withPool,
  poolLimits = { files: POOL_MIN_FILES, bytes: POOL_MIN_BYTES },
  // Receives the line the first run logs. The server passes console.log, and the
  // default prints nothing, so a test that builds a store stays quiet.
  log = () => {},
  now = Date.now,
} = {}) {
  const extractOne = extract || extractFile;
  // path -> { path, size, mtimeMs, version, onDisk, persisted, stored, dbOnDisk, compacted, rows }
  // stored: the database has a row for this path. It never goes back to false.
  // persisted: that row matches the rows in memory.
  // dbOnDisk: the on_disk value the database holds, so a failed write is retried.
  // compacted: compactRows() has slimmed the rows, so they must never be written.
  const map = new Map();
  // One string instance per repeated value (session id, model, tool name), shared by
  // every entry persist() compacts.
  const intern = new Map();
  let order = []; // the on-disk paths of the last walk, in walk order. Some may have no entry yet.
  let generation = 0;
  let inflight = null;
  let finishedAt = null;
  // Set once the first run has logged its line.
  let logged = false;
  // Paths whose last extract threw. The 5 s poll warns once per path, even while a
  // live session keeps growing. A clean extract removes the path.
  const warnedThrows = new Set();

  if (store) {
    for (const stored of store.loadAll()) map.set(stored.path, { ...stored, persisted: true, stored: true, dbOnDisk: stored.onDisk, compacted: true });
  }

  // True when the stored rows still describe the file on disk.
  function isCurrent(entry, st) {
    return !!entry && entry.rows.ok && entry.size === st.size && entry.mtimeMs === st.mtimeMs && entry.version === EXTRACT_VERSION;
  }

  // An extract that throws is an extractor bug. One bad transcript must not fail
  // every scan, so its rows count as a failed read: load keeps the previous entry,
  // or aggregate counts the file in meta.unreadableFiles.
  async function extractOrFail(file, extractWith) {
    let rows;
    try {
      rows = await extractWith(file);
    } catch (err) {
      if (!warnedThrows.has(file)) {
        warnedThrows.add(file);
        console.warn(`[rowstore] Extracting ${file} threw. Its last good rows stay, or it is left out if it has none.`, err);
      }
      return failedRows();
    }
    warnedThrows.delete(file);
    return rows;
  }

  // The entry of a file that is current and was marked gone: the transcript has come
  // back. Returns true when the entry changed.
  function reviveCurrent(previous) {
    if (previous.onDisk) return false;
    previous.onDisk = true;
    previous.persisted = false;
    return true;
  }

  // Reads a file that is new, changed or extracted by an older extractor, with
  // `extractWith`. A failed read keeps the previous entry when there is one. Returns
  // true when the entry changed.
  async function load(file, st, previous, extractWith) {
    const rows = await extractOrFail(file, extractWith);
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
  // store.put() writes entry.rows, so compacting before the write would drop stored
  // `usage` keys. Compaction runs only after the transaction succeeds, and it changes
  // the rows in memory, never the database row. Do not compact in load() either.
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
        compactRows(entry.rows, intern);
        entry.compacted = true;
      }
      for (const entry of vanished) entry.dbOnDisk = false;
    } catch (err) {
      const busy = isBusy(err) ? ' (database busy)' : '';
      console.warn(`[store] Could not write transcript rows${busy}, will retry on the next refresh: ${err.message}`);
    }
  }

  // Deletes the step files the database already holds and the mod is done with: on
  // disk, persisted, readable, and not written for STEP_FILE_KEEP_MS. The next stat
  // pass marks each gone, and its rows stay, as a deleted transcript's do. With no
  // store nothing is persisted, so nothing is deleted. An agent resumed between the
  // stat and the delete loses the steps of that one write.
  function pruneStepFiles() {
    const dir = agentUsageDir();
    if (!dir || !store) return;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const entry of map.values()) {
      if (!entry.path.startsWith(prefix) || !entry.onDisk || !entry.persisted || !entry.rows.ok) continue;
      if (now() - entry.mtimeMs <= STEP_FILE_KEEP_MS) continue;
      try {
        fs.unlinkSync(entry.path);
      } catch {
        // Already gone, or not removable. The next stat pass sees which.
      }
    }
  }

  // Handles the entries whose file is not in the latest walk. An entry that was never
  // stored is dropped. A stored entry is marked off disk. Returns the stored entries
  // the database does not yet reflect: `gone` needs its rows written, `vanished`
  // only needs on_disk cleared. `changed` is true when the map or an entry changed.
  function reconcileMissing(present) {
    const gone = [];
    const vanished = [];
    let changed = false;
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
    return { gone, vanished, changed };
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

  // Walks and stats every transcript, and fills `job` with the files to read. This
  // part has no await, so no other code sees the map between the first stat and the
  // last. `order` is set here, before any file is read: entries() skips the paths
  // that have no entry yet. A file that is current is not read. It moves its
  // generation only when it comes back from being gone. A file that comes back with
  // compacted rows is read again, because reviving it would write the compacted rows.
  // The files to read are sorted newest first, because the newest are the ones a
  // Today scan waits for.
  function statPass(job) {
    for (const file of [...findJsonlFiles(projectsDir()), ...findStepFiles(agentUsageDir())]) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue; // vanished since the directory walk
      }
      job.walk.push(file);
      const previous = map.get(file);
      if (isCurrent(previous, st) && (previous.onDisk || !previous.compacted)) {
        if (reviveCurrent(previous)) generation += 1;
        continue;
      }
      job.todo.push({ file, st, previous, hadEntry: !!previous, done: false });
    }
    job.todo.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    order = job.walk;
  }

  // A caller of refresh({ since }) waits for the files it needs, which are these: an
  // out-of-date file modified at or after `since`, and a file that has no entry yet.
  // A new file is waited for whatever its mtime, so a Today scan on an empty database
  // waits for the whole run, and the aggregate's scannedFiles is not short while files
  // are still being read. waiter.left counts the needed files not yet loaded. Pool
  // loads finish in any order, so a count is used instead of a position in the queue.
  const needs = (waiter, rec) => rec.st.mtimeMs >= waiter.since || !rec.hadEntry;

  // Resolves once the stat pass is done and every file the caller needs has loaded.
  // Files that finished before the caller joined are not counted. A run whose stat
  // pass threw is not done, so its waiters get the error from startRun.
  function waitFor(job, since) {
    return new Promise((resolve, reject) => {
      const waiter = { since, left: 0, resolve, reject };
      for (const rec of job.todo) if (!rec.done && needs(waiter, rec)) waiter.left += 1;
      job.waiters.push(waiter);
      if (waiter.left === 0 && job.statDone) resolve();
    });
  }

  // Tells every waiter that needs `rec` that it has loaded.
  function release(job, rec) {
    for (const waiter of job.waiters) {
      if (!needs(waiter, rec)) continue;
      waiter.left -= 1;
      if (waiter.left === 0) waiter.resolve();
    }
  }

  // Reads one file and counts the change. The entry's size and mtime are the ones
  // the stat pass saw, so a file that grows before it is read is read again by the
  // next refresh.
  async function loadRecord(job, rec, extractWith) {
    const read = deadWorkerFiles.has(deadKey(rec)) ? failedRows : extractWith;
    if (await load(rec.file, rec.st, rec.previous, read)) generation += 1;
    rec.done = true;
    release(job, rec);
  }

  // Files whose worker died after the pool had started, keyed by path, size and
  // mtime. A file in the set is not read again, on a worker or on the main thread,
  // and counts as unreadable until its size or mtime changes.
  const deadWorkerFiles = new Set();
  const deadKey = (rec) => `${rec.file}\0${rec.st.size}\0${rec.st.mtimeMs}`;

  // Out-of-date files are read on the main thread, or on worker threads when there
  // are enough of them to be worth starting a pool (POOL_MIN_FILES, POOL_MIN_BYTES).
  // A pool is asked for every file at once, newest first, and finishes them in any
  // order.
  async function readPass(job) {
    const bytes = job.todo.reduce((sum, rec) => sum + rec.st.size, 0);
    if (!openPool || job.todo.length <= poolLimits.files || bytes <= poolLimits.bytes) {
      for (const rec of job.todo) await loadRecord(job, rec, extractOne);
      return;
    }
    // No more workers than files: an idle worker costs a thread start for nothing.
    job.workers = Math.min(poolSize(), job.todo.length);
    await openPool(job.workers, (pool) => {
      // If no worker ever returned a result before every worker had exited or failed,
      // the pool never started (worker threads are unavailable). Its failed rows were
      // never read, so those files are extracted here instead, one at a time to keep
      // the open files few. A failed row waits for pool.started, which settles at the
      // first answer from any worker.
      // After any worker has returned a result, a worker that dies keeps its file
      // failed, and the file goes into deadWorkerFiles. Later runs skip it, so it is
      // not extracted on the main thread, until its size or mtime changes.
      let mainChain = Promise.resolve();
      const viaPool = async (rec) => {
        const file = rec.file;
        const rows = await pool.extract(file);
        if (rows.ok) return rows;
        if (!pool.started || (await pool.started)) {
          if (pool.started) deadWorkerFiles.add(deadKey(rec));
          return rows;
        }
        job.workers = 0; // the line logs a main-thread read, with no workers
        const mine = mainChain.then(() => extractOne(file));
        mainChain = mine.catch(() => {});
        return mine;
      };
      return Promise.all(job.todo.map((rec) => loadRecord(job, rec, () => viaPool(rec))));
    });
  }

  // One line when the first run finishes, whatever `since` its callers passed, so the
  // owner can see how long the first read took after a start or an extractor change.
  // The later runs read a few live files each and log nothing.
  // `elapsed` is taken before the database write, so the time is the read.
  function logFirstRun(job, elapsed) {
    if (logged) return;
    logged = true;
    const bytes = job.todo.reduce((sum, rec) => sum + rec.st.size, 0);
    const workers = job.workers ? ` with ${job.workers} worker${job.workers === 1 ? '' : 's'}` : '';
    log(`[rows] Read ${job.todo.length} of ${job.walk.length} transcripts (${formatBytes(bytes)}) in ${formatElapsed(elapsed)}${workers}`);
  }

  async function run(job) {
    if (rootUnreadable()) {
      job.statDone = true; // nothing to wait for
      return; // keep the map, order and generation as they were
    }
    const startedAt = performance.now();
    const midnight = windowStart('today', now());
    statPass(job);
    job.statDone = true;
    await readPass(job);

    const missing = reconcileMissing(new Set(job.walk));
    if (missing.changed) generation += 1;

    const elapsed = performance.now() - startedAt;
    const settled = job.walk.map((file) => map.get(file)).filter((e) => !e.persisted && e.rows.ok && e.mtimeMs < midnight);
    persist(settled, missing.gone, missing.vanished);
    pruneStepFiles();
    logFirstRun(job, elapsed);
  }

  function startRun() {
    const job = { walk: [], todo: [], waiters: [], statDone: false, workers: 0, done: null };
    inflight = job;
    job.done = run(job)
      .then(
        () => {
          finishedAt = now();
        },
        (err) => {
          // Cleared before the waiters hear of the error: a waiter that calls refresh
          // from its rejection handler runs before .finally, and would join this dead job.
          inflight = null;
          for (const waiter of job.waiters) waiter.reject(err);
          throw err;
        },
      )
      .finally(() => {
        if (inflight === job) inflight = null; // a waiter may have started the next run
      });
    // A caller that passed `since` never awaits job.done, so a failed run would
    // otherwise be an unhandled rejection. Callers that do await it still see the error.
    job.done.catch(() => {});
    return job;
  }

  return {
    // Concurrent callers share one run, and a run that finished under 2 s ago is reused.
    // With `since` (epoch ms), the promise resolves once the files that can hold rows
    // at or after `since` are loaded, which is before the older files are read, and
    // before reconcileMissing and persist. Without it, the promise resolves when the
    // whole run has finished, persist included.
    refresh({ since } = {}) {
      let job = inflight;
      if (!job) {
        if (finishedAt !== null && now() - finishedAt < REFRESH_SHARE_MS) return Promise.resolve();
        job = startRun();
      }
      return since == null ? job.done : waitFor(job, since);
    },
    // Retained entries whose transcript is gone come first, sorted by path, then the
    // files on disk in walk order. Walk order decides which duplicate row wins and
    // which session title is last, so it matches the order findJsonlFiles walks in.
    // A path with no entry yet (a new file during a run) is skipped.
    entries() {
      const onDisk = new Set(order);
      const retained = [...map.values()].filter((e) => !onDisk.has(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
      return [...retained, ...order.filter((p) => map.has(p)).map((p) => map.get(p))];
    },
    get generation() {
      return generation;
    },
  };
}

module.exports = { REFRESH_SHARE_MS, POOL_MIN_FILES, POOL_MIN_BYTES, STEP_FILE_KEEP_MS, formatBytes, formatElapsed, createRowStore };
