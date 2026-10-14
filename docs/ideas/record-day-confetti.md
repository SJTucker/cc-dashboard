# Confetti when today sets a new record day

Asked for on 2026-10-14: play a confetti animation when today becomes the record
day.

Record day is in the sticky bar (`public/index.html`, the "Record day" stat). It is
drawn by `renderRecord` in `public/panels/records.mjs`, from `/api/records` (fetched
on load and on Refresh) and the daily totals in the live summary (`busiestDay` in
`public/stats.mjs`). The live poll redraws it every 5 s.

## Open questions

- What counts as setting the record: today's tokens passing the stored record
  during the session, seen as one poll where the record day changes to today. A
  page loaded after today already holds the record should not fire it, or should
  fire it once per day.
- Whether it fires once per day per browser, kept in `localStorage`, so a reload or
  a second tab does not repeat it.
- Whether a cost record fires it too, since Record day shows tokens with the cost
  beside it.
- Under `prefers-reduced-motion: reduce` it does not play. The CSS already has six
  `prefers-reduced-motion` rules to follow.
- Drawn with CSS or a small canvas, with no new dependency.
