# Record-day card

Replace the **Sessions** card (`#cardSessions` in `public/index.html`) with a card that
shows the highest token count used in a single day.

## Decisions

- The card shows two records. The value and its date line are the all-time record.
  The note line is the record within the picked range.
- Tokens are all four kinds: input, output, cache writes and cache reads.
- Each record shows its date.
- Days are local calendar days, the same as the rest of the dashboard.
- On Today the note reads `today so far: <tokens>`. When the range's record day is
  the all-time record, the note reads `this range holds the record`.
- If today, or the range's record, beats the fetched all-time record, the card shows
  it as the all-time record straight away.

## Design

- `busiestDay(daily)` in `public/stats.js`, shared by the server and the browser.
  It groups buckets by `date.slice(0, 10)`, so Today's hourly buckets sum to one day.
- `GET /api/records` returns `{ allTime }` from the cached all-time scan
  (`getCached(null)` in `server.js`).
- The page fetches `/api/records` once per load and on a manual refresh. The 5-second
  live poll does not fetch it, because each cache miss starts a 2–4 second all-time
  scan.
- If `/api/records` fails, the value shows `—` and the note still shows the range line.

Removing the Sessions card also removes the mismatch between the Sessions count and
the Reported cost note's "over N of M sessions", which counts cost-state-only
sessions.
