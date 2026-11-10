'use strict';

const fs = require('fs');

// Reads files as lines, keeping the lines already read so a poll that finds a
// growing transcript only reads the appended bytes. An unterminated last line
// stays in `tail` (as bytes, so a multi-byte character split across two reads
// decodes correctly) until its newline arrives. A file that got smaller is read
// again from the start. Entries not read for `maxIdleMs` are dropped by prune().
function createLinesCache({ now = Date.now, maxIdleMs = 30 * 60 * 1000 } = {}) {
  const entries = new Map();

  function read(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      entries.delete(file);
      return null;
    }
    let e = entries.get(file);
    if (!e || st.size < e.offset) {
      e = { offset: 0, lines: [], tail: Buffer.alloc(0), size: 0, mtimeMs: 0, lastRead: 0 };
      entries.set(file, e);
    }
    e.lastRead = now();
    if (st.size > e.offset) {
      const buf = Buffer.alloc(st.size - e.offset);
      let n = 0;
      const fd = fs.openSync(file, 'r');
      try {
        n = fs.readSync(fd, buf, 0, buf.length, e.offset);
      } finally {
        fs.closeSync(fd);
      }
      e.offset += n;
      let data = Buffer.concat([e.tail, buf.subarray(0, n)]);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) {
        e.tail = data;
      } else {
        const text = data.subarray(0, end).toString('utf8');
        e.lines = e.lines.concat(text.split('\n'));
        e.tail = Buffer.from(data.subarray(end + 1));
      }
    }
    e.size = st.size;
    e.mtimeMs = st.mtimeMs;
    return { lines: e.lines, size: e.size, mtimeMs: e.mtimeMs };
  }

  function prune() {
    const cutoff = now() - maxIdleMs;
    for (const [file, e] of entries) if (e.lastRead <= cutoff) entries.delete(file);
  }

  return { read, prune, size: () => entries.size };
}

module.exports = { createLinesCache };
