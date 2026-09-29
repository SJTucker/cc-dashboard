# Token totals: the dashboard counts about half of what `/stats` shows

On 2026-09-29 the owner compared the dashboard with Claude Code's `/stats` screen.
`/stats` showed "Most active day: Sep 8" and "Total tokens: 10.7b". The Record day
card shows Sep 28, and the dashboard's all-time total is about 5.5B. The owner asked
whether the dashboard's token totals are wrong, or whether `/stats` still uses
inflated numbers from before Claude Code fixed an over-reporting bug.

## What was checked on 2026-09-29

`/stats` reads `~/.claude/stats-cache.json` (version 5, `lastComputedDate`
2026-09-28). That file has `dailyActivity` (messages, sessions and tool calls per
day), `dailyModelTokens` (tokens per day per model) and `modelUsage` (all-time
totals per model).

- **The record-day mismatch is explained.** "Most active day" ranks days by message
  count, not tokens. Sep 8 has 6,257 messages and Sep 28 has 6,070. By tokens,
  `stats-cache.json` agrees with the dashboard: Sep 28 is first (1,035.7M), then
  Sep 8 (818.2M).
- **The token totals differ by about 1.8x.** `modelUsage` sums to 0.2M input, 39.3M
  output, 9,926.9M cache read and 279.3M cache write. `scanUsage({ days: 'all' })` in
  `lib/scan.js` gives 0.1M input, 24.1M output, 5,355.5M cache read and 122.6M cache
  write.
- **The gap is on every day, and it varies.** Days both sources cover:

  | Day | `stats-cache.json` | Dashboard | Ratio |
  |---|---|---|---|
  | 2026-09-01 | 595.2M | 399.8M | 1.49 |
  | 2026-09-08 | 818.2M | 462.0M | 1.77 |
  | 2026-09-14 | 693.0M | 408.0M | 1.70 |
  | 2026-09-22 | 630.8M | 357.8M | 1.76 |
  | 2026-09-28 | 1,035.7M | 532.1M | 1.95 |

- **Some days are missing from the dashboard.** `stats-cache.json` starts on
  2026-08-20 (`firstSessionDate`). The dashboard's first day is 2026-08-28. On
  2026-08-26 and 2026-08-27, `stats-cache.json` has 253.0M and 601.8M tokens, and
  the dashboard has none. The transcripts for those days are probably gone. Claude
  Code deletes transcripts older than `cleanupPeriodDays`, which defaults to 30 days,
  and `stats-cache.json` keeps its own copy of the counts. Not confirmed.

## A likely cause, not confirmed

A transcript has one JSONL line per content block, and every line of one API
response repeats the same `usage`. `lib/scan.js` counts each response once, keyed on
`message.id` and `requestId`. A counter that adds up every line counts a response
once per content block. The number of content blocks per response varies, and that
would explain a ratio that changes from day to day between 1.5 and 2. If
`stats-cache.json` was built that way, the dashboard's numbers are the accurate
ones. If Claude Code fixed this later, its old daily counts would stay inflated,
because the file keeps them rather than recounting.

## To do

- Pick one recent day and count its transcript lines three ways: every line, once
  per `message.id`, and once per `message.id` + `requestId`. See which count matches
  `dailyModelTokens` for that day.
- Check whether any transcripts exist for 2026-08-20 to 2026-08-27, and read
  `cleanupPeriodDays` in `~/.claude/settings.json`.
- Check whether subagent transcripts, such as the files under a session's
  `subagents/` directory, are in `stats-cache.json` but not in the scan, or the
  other way round.

## Open questions

- If `stats-cache.json` counts every line, should the dashboard say on the page that
  its totals are lower than `/stats` on purpose?
- Should the dashboard read `stats-cache.json` to fill in days whose transcripts were
  deleted? If so, its inflated counts would need correcting first.
