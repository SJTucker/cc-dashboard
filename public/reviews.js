'use strict';

// Pure helpers for the Session reviews panel. Loaded by index.html before app.js,
// and required by test/reviews.test.js.

// The prompt the Copy prompt button puts on the clipboard, for a stronger model to
// check Haiku's suggestions against the transcript. Null when the review has no
// transcript path.
function reviewPrompt(review) {
  if (!review.transcript) return null;
  const lines = review.suggestions.map((s) => `- ${s.text}`).join('\n');
  return `Review the Claude Code session transcript at ${review.transcript}. A Haiku review of it suggested:\n${lines}\nWhich of these are right, which are wrong, and what did it miss?`;
}

// Replaces a leading home directory with ~. The folder name must end at the home
// path, so /Users/ab is not shortened by a home of /Users/a.
function shortPath(path, home) {
  if (!home) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

if (typeof module === 'object') module.exports = { reviewPrompt, shortPath };
