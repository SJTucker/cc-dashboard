'use strict';

const fs = require('node:fs');

// readStdin resolves with everything on `stream` as UTF-8 text, and rejects on a
// stream error. readInput reads the file named by `--input <path>` in `args`, deletes
// it and resolves with its text. Without `--input` it reads stdin. bin/judge-updates
// and bin/review-session use readInput, because the engine refuses a plugin's
// process.run whose stdin names a settings file, so the mod passes its text in a file.
// bin/record-statusline and bin/record-session-end keep their own loops, because they
// must exit 0 on any error instead of rejecting.
function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let input = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      input += chunk;
    });
    stream.on('end', () => resolve(input));
    stream.on('error', reject);
  });
}

async function readInput(args, stream = process.stdin) {
  const at = args.indexOf('--input');
  if (at < 0) return readStdin(stream);
  const file = args[at + 1];
  if (!file) throw new Error('--input needs a file path');
  const text = fs.readFileSync(file, 'utf8');
  try {
    fs.unlinkSync(file);
  } catch {
    // The text was read, so a failed delete changes nothing for the caller.
  }
  return text;
}

module.exports = { readStdin, readInput };
