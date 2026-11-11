'use strict';

const fs = require('fs');

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

// Appends one post to a board file with a single write, so posts from workers and
// the server running at once do not interleave. Title is cut to 120 characters, body
// to 2000. Returns the post written.
function appendPost(boardPath, { from, title, body = '' }, now = new Date()) {
  const post = { t: now.toISOString(), from, title: title.slice(0, 120), body: body.slice(0, 2000) };
  fs.appendFileSync(boardPath, JSON.stringify(post) + '\n');
  return post;
}

module.exports = { parseBoard, appendPost };
