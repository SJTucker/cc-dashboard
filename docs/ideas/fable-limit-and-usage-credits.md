# Fable weekly limit and usage credits

Show two more rows from Claude Code's `/usage` screen in the Plan usage panel. The
first is "Current week (Fable)", a weekly limit scoped to one model. The second is
"Usage credits", the monthly spend on extra usage, shown as "$41.17 / $200.00
spent · Resets Nov 1". Asked for on 2026-10-14.

## What exists

- `lib/limits.js` reads two sources and keeps only the two windows in `WINDOWS`,
  which are `five_hour` and `seven_day`.
- `rateLimitsInput` in `mod/hooks/statusline.ts` passes only the `five_hour` and
  `seven_day` kinds of `SessionRateLimit` on to `bin/record-statusline`.

## Where the data already is

Claude Code caches its last `/usage` fetch in `.claude.json` under
`cachedUsageUtilization.utilization`. `lib/limits.js` already reads that cache. On
2026-10-14 it held both rows:

- `limits` is a list of every window. Each entry has `kind`, `group`, `percent`,
  `severity`, `resets_at`, `scope` and `is_active`. The Fable row is
  `kind: "weekly_scoped"` with `scope.model.display_name: "Fable"` and
  `scope.model.id: null`. The other two entries are `session` and `weekly_all`.
- `extra_usage` holds the credits: `is_enabled`, `monthly_limit` (20000),
  `used_credits` (4117), `utilization`, `currency` ("USD") and `decimal_places` (2).
  The amounts are in cents, so 4117 is $41.17. The entry has no reset date. The
  screen's "Resets Nov 1" may be the first of next month in local time.
- `seven_day_opus` and `seven_day_sonnet` are null, and nothing in the
  `utilization` object is named for Fable. The `limits` list is the only place the
  Fable row appears.

## Open questions

- Whether the mod's `SessionRateLimit` has a kind for a model-scoped week or for
  credits. If it does, `bin/record-statusline` could keep these rows as fresh as
  the other two. If not, the rows are only as fresh as the last `/usage`.
- Where the reset date for credits comes from, if not from the cache.
- Whether to show every `weekly_scoped` entry the list holds, or only Fable's.
- Whether the limit band in the mod should warn on the Fable week, and on credits
  near `monthly_limit`.
- The cache is undocumented. The new fields need the same defensive reads that the
  module comment in `lib/limits.js` asks for.
