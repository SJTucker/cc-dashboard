# Five-hour window blocks

Bucket usage into rolling 5-hour windows, the way `/usage` reports them, instead of
calendar days. Moved from README "Extending it" on 2026-10-09.

## What exists

- The Plan usage panel shows the server-reported five-hour window as "Current
  session", with percent used and reset time (`WINDOWS` in `lib/limits.js`,
  `public/panels/limits.mjs`). The panel does not bucket calls.
- `aggregate` in `lib/aggregate.js` buckets by day or by hour only. `lib/dates.js`
  builds the hour slots for Today.

## Open questions

- How a window starts: at the first call after the previous window ended, as Claude
  Code's limit does, or on fixed boundaries.
- Whether the windows can be checked against the reset times in
  `<cfg>/rate-limits.json`.
- Which panel shows them, and for which ranges.
