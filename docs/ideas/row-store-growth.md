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

## Measured on 2026-10-11, before and after compaction

Same machine, a copy of the real database over 44.5 days: 2,022 transcripts on disk, about 61,300 calls and 68,300 tool uses.

| Quantity | Before compaction | After compaction |
|---|---|---|
| Heap of loaded rows (`store.loadAll()`, after `gc()`) | 60.6 MB (1.36 MB per day, 497 MB per year) | 37.4 MB (0.84 MB per day, 307 MB per year) |
| Heap after the first `refresh()` | 64.1 MB | 41.4 MB |
| All aggregate | 91.5 ms | 84.8 ms |
| 7d aggregate | 27 ms | 25.2 ms |
| All memo heap | 10.1 MB | 10.1 MB |
| Stat pass (directory walk plus `statSync`) | 6.8 ms + 3.5 ms | 6.8 ms + 3.1 ms |

Compaction (`lib/compact-rows.js`) replaces each call's raw `usage` object with the six fields `lib/aggregate.js` and `lib/pricing.js` read, and shares one string instance per repeated session id, model, version and tool name. `loadAll()` in `lib/store.js` and `persist()` in `lib/rowstore.js` apply it to rows in memory. The database keeps the full `usage` object, because it is the only copy once Claude Code deletes a transcript and because `output_tokens_details.thinking_tokens` is data no panel reads yet (`thinking-tokens.md`). `lib/extract.js` is unchanged and `EXTRACT_VERSION` did not change.

## Second trigger: the stat pass on each refresh

`statPass()` in `lib/rowstore.js` calls `fs.statSync` on every transcript that
`findJsonlFiles` returns, on every refresh. The cost grows with the number of
transcript files, even when none changed. The project review of 2026-10-08 named
two fixes:

- `fs.watch` on `<cfg>/projects/`, so a refresh stats only the files a change event
  named.
- Skipping a project folder whose directory mtime is unchanged. A directory's mtime
  changes when a file is added or removed, but not when an existing transcript is
  appended to, so this fix alone misses new lines in a running session.

The stat pass costs about 10 ms for 2,022 files (5 us per file). The pass counts only files on disk, and Claude Code deletes transcripts older than `cleanupPeriodDays`, so the count grows only while that setting is large.

## Decisions

Decided by the user on 2026-10-11.

1. **Compact rows now.** Accepted. Compaction applies to rows in memory only. The database keeps the full `usage` object. The change is one new file and two call sites, and it changes no output.
2. **Thresholds that start the heavier work.** Accepted:
   - All aggregate time above 500 ms. At the measured 2.1 ms per day of history that is about 240 days. Today it is 85 ms.
   - Loaded row heap above 400 MB. At 0.84 MB per day that is about 475 days after compaction. Today it is 37 MB.
   - Stat pass time (directory walk plus `statSync`) above 100 ms. At 5 us per file that is about 18,000 transcripts. Today it is about 10 ms.
3. **Daily totals or loading only the requested range.** Accepted: build neither as stated above. Both leave `/api/changes` reading every call of all time, and the Setup changes panel requests it on every page load. When a threshold trips, build a compact per-call column store (typed arrays, with strings as integer ids into shared tables) behind `scan(null)`. Decide that with fresh numbers at that point.
4. **`fs.watch` to replace the stat pass.** Accepted: do not build it. The stat pass costs about 10 ms. Whether `fs.watch` reports appends reliably on macOS is untested, and a missed append shows stale totals with no error.

## What each panel needs

| Panel or route | Needs per-call rows of all time? |
|---|---|
| Summary, ranges 7 / 30 / 90 and Today | No, rows in range only |
| Summary, All | Rows of all time, but only as sums |
| Live sessions (`/api/sessions/live`) | No, Today only |
| Records (`/api/records`) | No, daily totals suffice |
| Setup changes (`/api/changes`) | Yes, every call of all time (`efficiency.calls` and `efficiency.prompts` feed the model and version markers, session starts, Bash deltas and window stats) |

Daily totals for closed days do not remove the cost. The aggregate dedupes calls on `message.id:requestId` across session files and joins tool results to tool uses across files, so a per-day partial sum needs the dedupe keys of its day. Loading only the requested range does not help yet, because All and `/api/changes` need all rows and the Setup changes panel calls `/api/changes` on every page load.

## Open questions

- Whether `fs.watch` on macOS reports appends to a growing transcript within one poll. Test that only after the stat pass threshold trips.
- The column store layout for `efficiency.calls`, when a threshold trips.
