# Daily share of the weekly limit

Working five days a week, each workday gets about 20% of the weekly plan limit. Two
additions:

1. **A warning** when today's share of the weekly limit reaches 19%, one point short
   of the day's 20%. It sits with the existing 75% plan-limit warning
   (`#limitsBanner`).
2. **A panel** on the Today range that shows today's share of the weekly limit as it
   grows, against the 20% daily budget. For example: "Today: 12% of the week, budget
   20%".

## Where the numbers come from

The weekly figure is already on hand. `bin/record-limits` writes
`rate_limits.seven_day.used_percentage` and `resets_at` from the statusline to
`rate-limits.json` after every API response. On 2026-09-28 the values were whole
numbers (13, then 13 again twenty minutes later), so today's share also moves in
whole percents.

Today's share = the weekly percent now − the weekly percent when today started.

Nothing records the second number yet. `rate-limits.json` keeps only the latest
reading. So `recordRateLimits` in `lib/limits.js` also keeps a day baseline:

- On the first write of a new local day, save the previous reading's weekly percent
  as `dayStart: { date, percent }`. The previous reading is the last one from
  yesterday, so the baseline is yesterday's closing value and not today's first
  value. The first response of the day is then counted too.
- If the weekly window reset since that reading (`resets_at` has passed), the
  baseline is 0.
- If there is no earlier reading at all (first run), the baseline is the first
  reading of the day, and the panel says so.

## Open questions

- **Which days are workdays.** Mon–Fri with a 20% budget each is the simple rule.
  Weekend usage still counts toward the week. Should a weekend day show a budget of
  0% and warn at any use, or show no budget at all?
- **A fixed or a rolling budget.** Fixed means 20% every workday. Rolling means the
  remaining weekly percent divided by the workdays left before `resets_at`, so a light
  Monday leaves more for Tuesday and a heavy one leaves less. Rolling tracks the real
  limit better. Fixed is simpler to read.
- **The reset day.** The weekly window resets at `resets_at` (Oct 4 at 5am local on
  2026-09-28), not on Monday. A week that runs Saturday to Saturday still holds five
  workdays, but the panel should count workdays up to the reset, not Monday to
  Friday.
- **Configuring it.** The owner's numbers are five days and 20%. Anyone else would
  need to set their own, for example with environment variables in the style of
  `RATE_LIMITS_JSON`.
- **Mid-day reset.** When the weekly window resets during a workday, today's share
  becomes the usage since the reset. The usage before it belongs to the old week.
