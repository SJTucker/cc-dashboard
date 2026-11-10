'use strict';

// Parses the lines of a board file (written by bin/board-post, one JSON object
// per line, oldest first) into posts, newest first. Lines that are not JSON
// objects with string `t`, `from` and `title` are skipped. `body` defaults to ''.
function parseBoard(lines) {
  const posts = [];
  for (const line of lines) {
    let p;
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (!p || typeof p !== 'object' || typeof p.t !== 'string' || typeof p.from !== 'string' || typeof p.title !== 'string') continue;
    posts.push({ t: p.t, from: p.from, title: p.title, body: typeof p.body === 'string' ? p.body : '' });
  }
  return posts.reverse();
}

module.exports = { parseBoard };
