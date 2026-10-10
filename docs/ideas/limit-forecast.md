# Plan limit forecast

Estimate when the 5-hour window and the weekly limit will reach 100% at the current
rate, and show it in the Plan usage panel. Recorded on 2026-10-10.

## What exists

- `bin/record-statusline` writes the latest `rate_limits` reading to
  `<cfg>/rate-limits.json`, with `fetchedAtMs` and `dayStart`. It keeps no history of
  readings.
- The Plan usage panel shows percent used and reset time for both windows, and
  today's share of the week against two budgets (`lib/limits.js`).
- The 30-day cost projection card (`public/panels/cards.mjs`) projects dollars, not
  plan percent.

## Possible approach

Keep the readings of the current 5-hour window and the current week in a small file
or a table in `transcripts.db`. Fit the rate over the last hour for the 5-hour
window, and over the current day for the week. Show "at this rate, 100% at 15:40" when
that time comes before the reset, and nothing otherwise.

## Open questions

- Readings come in 1-point steps, so a rate over a short span is coarse. Decide the
  minimum span and number of readings before a forecast is shown.
- Usage outside Claude Code, such as claude.ai, moves the weekly percent with no
  reading. A forecast would jump when it lands.
- Whether a forecast for the week should skip the weekend, as the day budget does.
- SETUP.md's files table needs the new file or table.
