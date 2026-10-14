'use strict';

const fs = require('fs');

// Writes text to file through a tmp file and a rename, so a reader never sees a
// half-written file. The tmp file is `<file>.<pid>`. A snapshot's tmp name matches
// SESSION_FILE_PATTERN (lib/session-id.js), so prune removes one that a crash left.
// On any error the tmp file is removed and the error is rethrown. The folder must
// exist: callers that may be first to write it create it.
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the write failed before the tmp file existed
    }
    throw err;
  }
}

// Logs that file exists but could not be read or parsed, once per path in `warned`
// (a Set the caller keeps). A missing file is normal and logs nothing. The readers
// poll every few seconds, so without the Set one corrupt file would log on each poll.
function warnUnreadable(warned, file, err) {
  if (err?.code === 'ENOENT' || warned.has(file)) return;
  warned.add(file);
  console.warn(`[files] ${file} exists but could not be read, so it is skipped: ${err?.message ?? err}`);
}

const warnedJson = new Set();

// The parsed JSON in file, or null when it is missing, unreadable or not JSON.
// A file that exists and fails to parse also warns, once per path.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warnUnreadable(warnedJson, file, err);
    return null;
  }
}

module.exports = { writeFileAtomic, readJson, warnUnreadable };
