# Row store growth

The transcript row store keeps every extracted row in memory, and the All range aggregates all of them on each refresh. Memory and the All range time grow with history. The final review of the row store branch measured both on 2026-10-08. At the current rate, two to three years of history fit in Node's default heap and five do not.

## What was asked for

Raised by the final review of the row store branch (`lib/rowstore.js`, `lib/aggregate.js`, `lib/store.js`). The design spec left "daily totals for closed days, or doing the aggregation in SQL" out of scope until the All range gets too slow. The numbers below are the trigger to watch.

## Measured on 2026-10-08

The real database held 1420 files, 47,567 calls and 109,081 rows over 40.5 days.

- The loaded rows hold 46.9 MB of heap. That is about 420 MB per year at this rate.
- The All range aggregate takes 75 ms and its memo holds 7.2 MB. At 1.3M rows (about a year) that is about 0.9 s and 190 MB.
- Node's default heap limit on this machine is 4144 MB. Two to three years of history fit and five do not.
- The database file grows about 400 MB per year.

## Open questions

- **Threshold.** Decide what starts the work: a heap size, or an All aggregate time.
- **Option.** Daily totals for closed days, so old days are summed once and their rows are not aggregated again. Or loading only the rows inside the requested range, which keeps old rows in SQLite until a range asks for them.
