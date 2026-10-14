// Shared by the browser and the server, so both compute the same numbers: panels
// import it, and lib/efficiency.js and server.js's /api/records route require() it.

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

// Per-day token and cost totals, sorted by date ascending. Entries keyed by hour
// (`YYYY-MM-DDTHH`, used for the Today range) are summed into their day, so a
// caller never has to know whether it is looking at hourly or daily buckets.
function dayTotals(daily) {
  const totals = new Map(); // date -> { tokens, cost }
  for (const entry of daily) {
    const date = entry.date.slice(0, 10);
    const tokens = entry.input + entry.output + entry.cacheCreate + entry.cacheRead;
    const total = totals.get(date) || { tokens: 0, cost: 0 };
    total.tokens += tokens;
    total.cost += entry.cost;
    totals.set(date, total);
  }
  return [...totals]
    .map(([date, { tokens, cost }]) => ({ date, tokens, cost }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The busiest calendar day across a `daily` array, with that day's token total and
// cost. The day is chosen by tokens, and a tie keeps the earlier date. The cost is
// that day's cost, even when another day cost more.
// Returns null for an empty array or when every day has 0 tokens.
function busiestDay(daily) {
  let best = null;
  for (const { date, tokens, cost } of dayTotals(daily)) {
    if (tokens <= 0) continue;
    if (!best || tokens > best.tokens) best = { date, tokens, cost };
  }
  return best;
}

// Today plus the 6 calendar days before it. `priorDays` is a dayTotals list; only
// its entries from the 6 days before `todayStr` count, so an entry dated today is
// ignored and `today` ({ cost, tokens }, the live total) is not counted twice.
// The window start is local-date arithmetic, so a daylight saving change cannot
// shift it. Returns null while `priorDays` is null, i.e. before the data arrives.
function rollingWeek(priorDays, todayStr, today) {
  if (!priorDays) return null;
  const start = new Date(todayStr + 'T00:00:00');
  start.setDate(start.getDate() - 6);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const week = { cost: today.cost, tokens: today.tokens };
  for (const d of priorDays) {
    if (d.date >= from && d.date < todayStr) {
      week.cost += d.cost;
      week.tokens += d.tokens;
    }
  }
  return week;
}

export { median, percentile, dayTotals, busiestDay, rollingWeek };
