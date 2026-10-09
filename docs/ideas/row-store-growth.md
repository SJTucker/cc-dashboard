# Row store growth

The transcript row store keeps every extracted row in memory. The All range
aggregates all of them again whenever a transcript changes or the date rolls over
(`scan()` in `server.js` reuses the result otherwise). Memory and the All range time
grow with history. The final review of the row store branch measured both on 2026-10-08. At the current rate, two to three years of history fit in Node's default heap and five do not.

## What was asked for

Raised by the final review of the row store branch (`lib/rowstore.js`, `lib/aggregate.js`, `lib/store.js`). The design spec left "daily totals for closed days, or doing the aggregation in SQL" out of scope until the All range gets too slow. The numbers below are the trigger to watch.

## Measured on 2026-10-08

The real database held 1420 files, 47,567 calls and 109,081 rows over 40.5 days.

- The loaded rows hold 46.9 MB of heap. That is about 420 MB per year at this rate.
- The All range aggregate takes 75 ms and its memo holds 7.2 MB. At 1.3M rows (about a year) that is about 0.9 s and 190 MB.
- Node's default heap limit on this machine is 4144 MB. Two to three years of history fit and five do not.
- The database file grows about 400 MB per year.

## Second trigger: the stat pass on each refresh

`run()` in `lib/rowstore.js` calls `fs.statSync` on every transcript that
`findJsonlFiles` returns, on every refresh. The cost grows with the number of
transcript files, even when none changed. The project review of 2026-10-08 named
two fixes:

- `fs.watch` on `<cfg>/projects/`, so a refresh stats only the files a change event
  named.
- Skipping a project folder whose directory mtime is unchanged. A directory's mtime
  changes when a file is added or removed, but not when an existing transcript is
  appended to, so this fix alone misses new lines in a running session.

Measure the stat pass time with the heap size and the All aggregate time.

## Open questions

- **Threshold.** Decide what starts the work: a heap size, or an All aggregate time.
- **Option.** Daily totals for closed days, so old days are summed once and their rows are not aggregated again. Or loading only the rows inside the requested range, which keeps old rows in SQLite until a range asks for them.
- **Stat pass.** Decide what stat pass time starts the work, and whether
  `fs.watch` on macOS reports appends reliably enough to replace the stat pass.
