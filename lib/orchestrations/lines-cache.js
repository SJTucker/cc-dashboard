'use strict';

const fs = require('fs');

// Reads files as lines, keeping the lines already read so a poll that finds a
// growing transcript only reads the appended bytes. An unterminated last line
// stays in `tail` (as bytes, so a multi-byte character split across two reads
// decodes correctly) until its newline arrives. A file that got smaller is read
// again from the start, as is one whose inode changed or whose mtime changed
// without growing (a rewrite of the same size). A rewrite that grows the file in
// place keeps its inode and looks like an append, so it is not noticed.
// Entries not read for `maxIdleMs` are dropped by prune().
//
// read(file) returns { lines, size, mtimeMs, version } or null. An entry keeps one
// `lines` array and pushes new lines into it, so the array reference does not
// change when the file grows. The array is replaced by a new one exactly when the
// entry starts over (shrink, inode change, or a same-size rewrite), so a caller can
// tell a reset from growth by comparing array identity. `version` takes a new value
// from one counter whenever lines were added and whenever the entry starts over.
// The counter is shared by every file and never repeats, so a value seen before an
// entry was dropped is never handed out again. forget(file) drops one entry.
function createLinesCache({ now = Date.now, maxIdleMs = 30 * 60 * 1000 } = {}) {
  const entries = new Map();
  let versions = 0;

  function read(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      entries.delete(file);
      return null;
    }
    let e = entries.get(file);
    const rewritten = e && (st.size < e.offset || st.ino !== e.ino || (st.size === e.offset && st.mtimeMs !== e.mtimeMs));
    if (!e || rewritten) {
      e = { offset: 0, lines: [], tail: Buffer.alloc(0), size: 0, mtimeMs: 0, ino: st.ino, version: ++versions, lastRead: 0 };
      entries.set(file, e);
    }
    e.lastRead = now();
    if (st.size > e.offset) {
      const buf = Buffer.alloc(st.size - e.offset);
      let n = 0;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          n = fs.readSync(fd, buf, 0, buf.length, e.offset);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        entries.delete(file);
        return null;
      }
      e.offset += n;
      let data = Buffer.concat([e.tail, buf.subarray(0, n)]);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) {
        e.tail = data;
      } else {
        const text = data.subarray(0, end).toString('utf8');
        for (const line of text.split('\n')) e.lines.push(line);
        e.version = ++versions;
        e.tail = Buffer.from(data.subarray(end + 1));
      }
    }
    e.size = st.size;
    e.mtimeMs = st.mtimeMs;
    return { lines: e.lines, size: e.size, mtimeMs: e.mtimeMs, version: e.version };
  }

  function prune() {
    const cutoff = now() - maxIdleMs;
    for (const [file, e] of entries) if (e.lastRead <= cutoff) entries.delete(file);
  }

  function forget(file) {
    entries.delete(file);
  }

  return { read, prune, forget, size: () => entries.size };
}

module.exports = { createLinesCache };
