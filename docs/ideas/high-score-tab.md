# High score tab

A third tab beside Now and Analysis that lists the all-time records, drawn in an
arcade high-score style. Asked for on 2026-10-15.

## What it lists

The examples given were the highest token day, the highest cost day, the highest
prompt day and the highest session. Added on 2026-10-15: the most lines of code added
in one day and the most lines deleted in one day. Other records that come from data
the dashboard already has:

- Most sessions in one day.
- The most expensive single session and the longest session.
- The longest turn, once `turn_duration` lines are stored (the turns-and-fillers
  branch).
- Longest streak of days with any activity.
- The highest cache hit rate on a day above some minimum of calls.

## What exists

- The sticky bar's Record day stat shows one record: the day with the most tokens,
  with its cost (`renderRecord` in `public/panels/records.mjs`).
- `/api/records` in `server.js` returns that day as `allTime`, from `busiestDay` in
  `public/stats.mjs` over `scan(null).daily`. The all-time aggregate is already
  computed for the All range and `/api/changes`, so more records cost little.
- Daily buckets in `lib/aggregate.js` hold tokens and cost per day. Prompt counts per
  day come from `efficiency.prompts`. Session totals come from the session snapshots
  and from call rows grouped by `sessionId`.
- Lines added and removed come from the `edits` rows `collectEdits` in
  `lib/extract.js` writes for each Edit and Write result (`{ toolUseId, t, sessionId,
  added, removed }`). `addEdits` in `lib/aggregate.js` sums them per session
  (`linesBySession`). Each `daily` bucket also has `linesAdded`, `linesRemoved` and
  `linesByRepo`.
- [Record day confetti](record-day-confetti.md) plays when today sets a new record.
  The two ideas share the "new record" rule.

## Open questions

- **Which records.** The final list, and whether each shows only first place or a
  top 10 table, as an arcade screen does.
- **The look.** Pixel font, all-caps names, rank numbers and blinking text, kept
  within the design pass's tokens and both themes. Under
  `prefers-reduced-motion: reduce` nothing blinks.
- **Which session counts as "highest".** Most tokens, most cost or most prompts, and
  whether a `/clear` chain counts as one session, as the Live sessions table groups
  it.
- **Today's place.** Whether each table marks where today would rank, so a record
  being set is visible before the day ends.
- **History.** Transcripts Claude Code deleted keep their stored rows, so call-based
  records reach back to the first stored day. Records that need rows added in a later
  extract version start at that version.
