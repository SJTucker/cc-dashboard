# Today (share of the week): double-check the numbers

The owner looked at the Plan usage panel on 2026-09-29 at 9:49am and was not sure
the "Today (share of the week)" row was correct. It showed:

- Current week (all models): 22% used, resets Oct 4 at 5am.
- Today (share of the week): 1% of the week, with the note "budget 20% · rolling
  20% (4 workdays to reset)". The bar was about a twentieth full.

## What was checked on 2026-09-29

`~/.claude/rate-limits.json` held
`dayStart: { date: '2026-09-29', percent: 21, from: 'previous-reading' }`, with
the week at 22%. The feature merged at 9:47am (1319cda), so `bin/record-statusline`
first wrote `dayStart` a few minutes after that.

- **The 1% is too low.** The file had no `dayStart` before the merge.
  `dayStartFor` in `lib/limits.js` then took the previous reading as the day's
  start, but that reading was from earlier the same morning, not from yesterday.
  The usage from midnight to 9:47am is missing from today's share. A reading on
  2026-09-28 had the week at 13%, so at most 8 points (21 − 13) are missing.
- **The cause is in `dayStartFor`.** It returns `from: 'previous-reading'` whenever
  a previous reading exists and no same-day `dayStart` does. It never checks that
  the previous reading is from an earlier day. When the previous reading is from
  today, the true start of the day is unknown. The row should then say "counted
  from today's first reading" (`from: 'first-reading'`), not present the value as
  the day's start.
- **Where else it happens.** This case only arises when the file has a same-day
  reading and no `dayStart`: the first write after upgrading, or a file written by
  an older copy of the script. From 2026-09-30 on, the baseline should be
  yesterday's last reading.
- **The rolling budget is consistent.** (100 − 21) ÷ 4 workdays (Tue to Fri, since
  the Sunday 05:00 reset leaves Saturday and Sunday out) is 19.75, shown as 20%.
- **The bar length is as designed, but it may read wrong.** The Today bar fills
  against the 20% budget: 1 ÷ 20 is 5% of the track. The weekly bars above it fill
  against 100%. Two bars with different scales in one panel can look like a
  mistake.

## To do

- Check the row again on 2026-09-30, after the first day with a baseline from
  yesterday's last reading. Compare today's share with the weekly percent at the end
  of 2026-09-29.
- Fix `dayStartFor` to use `from: 'first-reading'` when the previous reading is from
  the same local day and no `dayStart` exists. Add a test for that case.

## Open questions

- Should the Today bar fill against the budget, as now, or against 100% like the
  bars above it? If it stays against the budget, should the row say so, for example
  "1% of the week · bar is out of the 20% budget"?
