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

// Logs that file could not be read or parsed and was skipped, once per path in `warned`
// (a Set the caller keeps). A missing file is normal and logs nothing. The readers
// poll every few seconds, so without the Set one corrupt file would log on each poll.
// A SyntaxError means the text was not JSON, often a file caught mid-write. Any other
// error is an I/O failure such as EACCES, and its code and message say why.
// Callers pass the path to readable() after a good read, which re-arms the warning
// for a file that breaks again.
function warnUnreadable(warned, file, err) {
  if (err?.code === 'ENOENT' || warned.has(file)) return;
  warned.add(file);
  if (err instanceof SyntaxError) {
    console.warn(`[files] ${file} could not be parsed and was skipped, possibly because it was being written: ${err.message}`);
  } else {
    console.warn(`[files] ${file} could not be read and was skipped: ${err?.code && !String(err.message).startsWith(err.code) ? `${err.code} ` : ''}${err?.message ?? err}`);
  }
}

// Marks file as readable again, so the next failure on it warns.
function readable(warned, file) {
  warned.delete(file);
}

const warnedJson = new Set();

// The parsed JSON in file, or null when it is missing, unreadable or not JSON.
// A file that exists and fails to read or parse also warns, once until it reads again.
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    readable(warnedJson, file);
    return parsed;
  } catch (err) {
    warnUnreadable(warnedJson, file, err);
    return null;
  }
}

module.exports = { writeFileAtomic, readJson, warnUnreadable, readable };
