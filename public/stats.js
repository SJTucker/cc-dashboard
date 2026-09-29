'use strict';

// Loaded two ways, so the server and the browser compute the same numbers:
// index.html loads it as a script before app.js, which makes these functions
// globals, and lib/efficiency.js loads it with require(). server.js's
// /api/records route also requires it directly.

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

// The busiest calendar day across a `daily` array, with that day's token total and
// cost. Entries keyed by hour (`YYYY-MM-DDTHH`, used for the Today range) are
// summed into their day first, so a caller never has to know whether it is looking
// at hourly or daily buckets. The day is chosen by tokens, and a tie keeps the
// earlier date. The cost is that day's cost, even when another day cost more.
// Returns null for an empty array or when every day has 0 tokens.
function busiestDay(daily) {
  const totals = new Map(); // date -> { tokens, cost }
  for (const entry of daily) {
    const date = entry.date.slice(0, 10);
    const tokens = entry.input + entry.output + entry.cacheCreate + entry.cacheRead;
    const total = totals.get(date) || { tokens: 0, cost: 0 };
    total.tokens += tokens;
    total.cost += entry.cost;
    totals.set(date, total);
  }
  let best = null;
  for (const [date, { tokens, cost }] of totals) {
    if (tokens <= 0) continue;
    if (!best || tokens > best.tokens || (tokens === best.tokens && date < best.date)) best = { date, tokens, cost };
  }
  return best;
}

if (typeof module === 'object') module.exports = { median, percentile, busiestDay };
