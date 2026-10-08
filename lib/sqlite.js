'use strict';

// node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature" when it
// loads. In the server that line lands on top of server.js's startup banner and reads
// like a fault. Only that one warning is dropped, and only while the require runs, so
// anything else Node prints still gets through. --no-warnings would drop everything.
// lib/db.js and lib/rtk.js take DatabaseSync from here. node:sqlite needs no flag on
// the Node 22.13 floor in package.json, so there is no fallback for a failed require.

const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...rest);
};
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} finally {
  process.emitWarning = emitWarning;
}

module.exports = { DatabaseSync };
