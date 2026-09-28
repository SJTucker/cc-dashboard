'use strict';

// Loaded two ways, so the server and the browser compute the same numbers:
// index.html loads it as a script before app.js, which makes these functions
// globals, and lib/efficiency.js loads it with require().

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank: always a value that occurred, which is what a reader expects of
// "90% of Bash results were under N".
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

if (typeof module === 'object') module.exports = { median, percentile };
