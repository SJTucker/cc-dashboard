'use strict';

const fs = require('fs');
const path = require('path');

// Claude Code writes one JSONL transcript per session under <config dir>/projects.
function getProjectsDir(configDir) {
  return path.join(configDir, 'projects');
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

module.exports = { getProjectsDir, findJsonlFiles };
