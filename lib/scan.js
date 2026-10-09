'use strict';

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('./config-dir');
const { extractFile, forEachLine, isTypedPrompt, toolDetail, resultText } = require('./extract');
const { aggregate } = require('./aggregate');
const { windowStart, localDateStr } = require('./dates');

function getProjectsDir() {
  return path.join(getConfigDir(), 'projects');
}

/** Recursively collect every *.jsonl file under a directory. Read-only: never writes. */
function findJsonlFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results; // directory doesn't exist or isn't readable - not fatal
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Scans every session file under ~/.claude/projects and aggregates token usage and
 * estimated cost by day and by model, restricted to the last `days` days (or all
 * time if days is null). It reads every file it does not skip, on every call. The
 * server uses lib/rowstore.js instead, which reads a file again only when it
 * changes. Read-only throughout: only fs.readdirSync, fs.statSync and
 * fs.createReadStream are used.
 */
async function scanUsage({ days = 30, bucket = 'day' } = {}) {
  const projectsDir = getProjectsDir();
  const files = findJsonlFiles(projectsDir);
  const now = Date.now();
  const cutoff = windowStart(days, now);

  const entries = [];
  for (const file of files) {
    // A session file is appended to as entries are written, so its mtime is the
    // timestamp of its newest entry. One last written before the cutoff cannot
    // hold an in-range entry, so skip it without reading. This is what makes the
    // 'today' range cheap enough to poll: 20 files instead of 729 on a typical
    // log directory. statSync throwing means the file vanished since the
    // directory walk, which is also nothing to read.
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

module.exports = { scanUsage, getProjectsDir, localDateStr, findJsonlFiles, forEachLine, isTypedPrompt, toolDetail, resultText };
