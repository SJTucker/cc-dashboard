'use strict';

// Resolves with everything on `stream` as UTF-8 text, and rejects on a stream
// error. bin/judge-updates and bin/review-session use it. bin/record-statusline and
// bin/record-session-end keep their own loops, because they must exit 0 on any
// error instead of rejecting.
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

module.exports = { readStdin };
