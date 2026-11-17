'use strict';

// Mirrors <cfg>/projects into <cfg>/cc-dashboard/archive as gzipped copies.
// A transcript only grows, so each run appends the new bytes as another gzip
// member. zlib.gunzipSync and gunzip -c read concatenated members as one stream.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { writeFileAtomic, readJson } = require('./files');

const STALE_LOCK_MS = 15 * 60_000;
const TAKEOVER_STALE_MS = 60_000;
const HEAD_BYTES = 4096;
const BLOCK = 64 * 1024;

function getArchiveDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'archive');
}

// Collects every *.jsonl and agent-*.meta.json under dir as paths relative to
// root. Follows only directories and regular files, so symlinks are skipped.
function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.jsonl')) out.jsonl.push(path.relative(root, full));
      else if (entry.name.startsWith('agent-') && entry.name.endsWith('.meta.json')) out.meta.push(path.relative(root, full));
    }
  }
}

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Offset just past the last "\n" in the first `size` bytes, or 0 when none.
function lastNewlineEnd(fd, size) {
  let pos = size;
  while (pos > 0) {
    const start = Math.max(0, pos - BLOCK);
    const buf = readRange(fd, start, pos - start);
    const i = buf.lastIndexOf(0x0a);
    if (i !== -1) return start + i + 1;
    pos = start;
  }
  return 0;
}

function loadState(file) {
  const parsed = readJson(file);
  if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
    return { version: 1, files: parsed.files };
  }
  return { version: 1, files: {} };
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function writeFresh(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(data));
  fs.renameSync(tmp, dest);
}

function archiveOne(rel, c) {
  const src = path.join(c.projectsDir, rel);
  const dest = path.join(c.archiveDir, `${rel}.gz`);
  const fd = fs.openSync(src, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const end = lastNewlineEnd(fd, size);
    if (end === 0) return 'unchanged';
    const rec = c.state.files[rel];
    const destExists = fs.existsSync(dest);
    let outcome;
    if (rec && destExists) {
      const keep = Math.min(rec.bytes, HEAD_BYTES);
      let changed = end < rec.bytes || sha(readRange(fd, 0, keep)) !== rec.head;
      if (!changed) changed = sha(readRange(fd, rec.bytes - keep, keep)) !== rec.tail;
      if (changed) {
        fs.renameSync(dest, path.join(c.archiveDir, `${rel.slice(0, -'.jsonl'.length)}.rewritten-${stamp(c.now())}.jsonl.gz`));
        writeFresh(dest, readRange(fd, 0, end));
        outcome = 'rewritten';
      } else if (fs.statSync(dest).size === rec.gzBytes) {
        if (end === rec.bytes) return 'unchanged';
        fs.appendFileSync(dest, zlib.gzipSync(readRange(fd, rec.bytes, end - rec.bytes)));
        outcome = 'appended';
      } else {
        writeFresh(dest, readRange(fd, 0, end));
        outcome = 'rebuilt';
      }
    } else {
      writeFresh(dest, readRange(fd, 0, end));
      outcome = destExists ? 'rebuilt' : 'added';
    }
    const keep = Math.min(end, HEAD_BYTES);
    c.state.files[rel] = {
      bytes: end,
      gzBytes: fs.statSync(dest).size,
      head: sha(readRange(fd, 0, keep)),
      tail: sha(readRange(fd, end - keep, keep)),
    };
    return outcome;
  } finally {
    fs.closeSync(fd);
  }
}

function copyMeta(rel, c) {
  const src = path.join(c.projectsDir, rel);
  const dest = path.join(c.archiveDir, rel);
  const data = fs.readFileSync(src);
  try {
    if (fs.readFileSync(dest).equals(data)) return false;
  } catch {
    // no copy yet
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.tmp`, data);
  fs.renameSync(`${dest}.tmp`, dest);
  return true;
}

function archiveTranscripts({ projectsDir, archiveDir, saveEvery = 50, now = Date.now }) {
  const result = { added: 0, appended: 0, rebuilt: 0, rewritten: 0, unchanged: 0, metaCopied: 0, failed: 0, firstError: null };
  fs.mkdirSync(archiveDir, { recursive: true });
  const stateFile = path.join(archiveDir, 'state.json');
  const state = loadState(stateFile);
  const c = { projectsDir, archiveDir, state, now };
  const found = { jsonl: [], meta: [] };
  walk(projectsDir, projectsDir, found);

  const fail = (err) => {
    result.failed += 1;
    if (result.firstError === null) result.firstError = err.message;
  };
  let sinceSave = 0;
  for (const rel of found.jsonl) {
    let outcome;
    try {
      outcome = archiveOne(rel, c);
    } catch (err) {
      if (err.code !== 'ENOENT') fail(err);
      continue;
    }
    result[outcome] += 1;
    if (outcome === 'unchanged') continue;
    sinceSave += 1;
    if (outcome === 'rewritten' || sinceSave >= saveEvery) {
      writeFileAtomic(stateFile, JSON.stringify(state));
      sinceSave = 0;
    }
  }
  for (const rel of found.meta) {
    try {
      if (copyMeta(rel, c)) result.metaCopied += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') fail(err);
    }
  }
  const inWalk = new Set(found.jsonl);
  for (const rel of Object.keys(state.files)) {
    if (!inWalk.has(rel)) delete state.files[rel];
  }
  writeFileAtomic(stateFile, JSON.stringify(state));
  return result;
}

function parseLock(lock) {
  let text;
  try {
    text = fs.readFileSync(lock, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let startedAt = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && Number.isFinite(parsed.startedAt)) startedAt = parsed.startedAt;
  } catch {
    // an unparseable lock ages by its mtime
  }
  if (startedAt === null) startedAt = fs.statSync(lock).mtimeMs;
  return { startedAt };
}

function withArchiveLock(archiveDir, fn, now = Date.now) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const lock = path.join(archiveDir, '.lock');
  const takeover = path.join(archiveDir, '.lock.takeover');
  const tmp = path.join(archiveDir, `.lock.${process.pid}`);
  const mine = { pid: process.pid, startedAt: now() };
  const isStale = () => {
    try {
      const held = parseLock(lock);
      return held === null ? 'gone' : now() - held.startedAt >= STALE_LOCK_MS ? 'stale' : 'fresh';
    } catch {
      return 'fresh';
    }
  };

  fs.writeFileSync(tmp, JSON.stringify(mine));
  let linked = false;
  try {
    try {
      fs.linkSync(tmp, lock);
      linked = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (!linked) {
      const state = isStale();
      if (state === 'fresh') return { ran: false };
      let held = false;
      try {
        for (let attempt = 0; attempt < 2 && !held; attempt += 1) {
          try {
            fs.closeSync(fs.openSync(takeover, 'wx'));
            held = true;
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            let age = Infinity;
            try {
              age = Date.now() - fs.statSync(takeover).mtimeMs;
            } catch {
              // released between the two calls: try again
            }
            if (age <= TAKEOVER_STALE_MS) return { ran: false };
            try {
              fs.unlinkSync(takeover);
            } catch {
              // another run removed it first
            }
          }
        }
        if (!held) return { ran: false };
        if (isStale() === 'fresh') return { ran: false };
        try {
          fs.unlinkSync(lock);
        } catch {
          // already gone
        }
        try {
          fs.linkSync(tmp, lock);
          linked = true;
        } catch (err) {
          if (err.code === 'EEXIST') return { ran: false };
          throw err;
        }
      } finally {
        if (held) {
          try {
            fs.unlinkSync(takeover);
          } catch {
            // already gone
          }
        }
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
  }

  try {
    return { ran: true, result: fn() };
  } finally {
    try {
      const cur = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (cur.pid === mine.pid && cur.startedAt === mine.startedAt) fs.unlinkSync(lock);
    } catch {
      // lock missing or replaced
    }
  }
}

module.exports = { archiveTranscripts, withArchiveLock, getArchiveDir, STALE_LOCK_MS, HEAD_BYTES };
