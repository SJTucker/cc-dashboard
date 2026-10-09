'use strict';

// scanUsage reads every transcript under projectsDir on each call and aggregates
// them. The server uses lib/rowstore.js instead, which reads a file again only when
// it changes. test/scan.test.js keeps scanUsage as the reference reader for the
// extract and aggregate steps. Not a test file, so the test/*.test.js glob skips it.
// Read-only throughout: only fs.readdirSync, fs.statSync and fs.createReadStream
// are used.

const fs = require('fs');
const { extractFile } = require('../lib/extract');
const { aggregate } = require('../lib/aggregate');
const { windowStart } = require('../lib/dates');
const { findJsonlFiles } = require('../lib/transcript-files');

async function scanUsage({ days = 30, bucket = 'day', projectsDir }) {
  const files = findJsonlFiles(projectsDir);
  const now = Date.now();
  const cutoff = windowStart(days, now);

  const entries = [];
  for (const file of files) {
    // A session file is appended to as entries are written, so its mtime is the
    // timestamp of its newest entry. One last written before the cutoff cannot hold
    // an in-range entry, so it is skipped without reading. statSync throwing means
    // the file vanished since the directory walk, which is also nothing to read.
    if (cutoff != null) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;
    }
    entries.push(await extractFile(file));
  }

  const data = aggregate(entries, { days, bucket, now, projectsDir });
  data.meta.scannedFiles = files.length; // the files found, not only the ones read
  return data;
}

module.exports = { scanUsage };
