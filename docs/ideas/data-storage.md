# Data storage and scan cost

Find out whether storing everything in files will slow the dashboard down as data
grows, and whether a database would help. Asked for on 2026-10-07.

## What was asked for

- **How data is stored today.** Confirm whether the dashboard uses files only.
- **Growth over time.** Find out whether reads get slower as history builds up.
- **A database.** Decide whether one is worth adding.

## What is stored today

Everything is files, except rtk's own SQLite database, which the dashboard reads
with `node:sqlite` (`lib/rtk.js`) and does not write.

Measured on this machine on 2026-10-07:

| Data | Written by | Size | Pruned |
|---|---|---|---|
| `~/.claude/projects/**/*.jsonl` | Claude Code | 1427 files, 1.5 GB, oldest 2026-09-04 | By Claude Code after `cleanupPeriodDays` (30 by default) |
| `cc-dashboard/sessions/` | `bin/record-statusline` | 8 files, 32 KB | Yes, `prune` in `lib/sessions.js` |
| `cc-dashboard/activity/` | the mod | 6 files, 24 KB | Yes, `lib/activity.js` |
| `cc-dashboard/reviews/` | `bin/review-session` | 21 files, 84 KB | Yes, after 7 days (`pruneReviews`) |
| `cc-dashboard/setup/` | the mod | 15 files, 116 KB | Not checked |
| `cc-dashboard/changes/` | the mod | 0 files | Not checked |
| `records.json`, `prices.json`, `updates.json` | the server, `bin/judge-updates` | under 5 KB each | One file each, rewritten in place |

The transcripts are the only large data. The dashboard's own files are small, and
most are pruned.

## How reads work today

- `scanUsage` in `lib/scan.js` re-reads every transcript in the range, in full, on
  each scan. It keeps no per-file offset and no parsed cache on disk.
- The Today scan skips files whose mtime is before today, so it reads about 20 files.
- `server.js` caches each range's scan result in memory for 60 seconds
  (`CACHE_TTL_MS`). The Today scan is shared for 2 seconds (`getTodayScan`).
- `/api/changes` reads the all-history scan. A comment in `public/app.js` says that
  takes about 2.4 s when the cache entry is cold.
- `records.json` caches the record day so the page does not scan all history on
  every load.

## Why growth may stay bounded

Claude Code deletes transcripts after `cleanupPeriodDays`. With the default of 30, all
history is about 30 days and does not keep growing. The scan cost grows with how much
is done in 30 days, not with how long the dashboard has been in use.

This stops holding when:

- `cleanupPeriodDays` is raised. Then the 90d and All ranges, and `/api/changes`,
  read more each time.
- Usage per day grows. More sessions and subagents make larger transcripts.
- History is wanted after Claude Code deletes it. Today that history is lost, and
  only `records.json` keeps anything past 30 days.

## Open questions

- **Measure first.** Time the cold all-history scan, the 90d scan and `/api/changes`
  now, and record bytes read per scan. Decide on a threshold (for example 5 s cold)
  that would justify a change.
- **Where the time goes.** Reading and `JSON.parse` of every line, or the work done
  per call. A profile of `scanUsage` on all history answers this.
- **Cheaper options before a database:**
  - An incremental scan: keep each file's byte offset and partial totals, and read
    only lines appended since the last scan. Transcripts are append-only.
  - A daily summary file: per day, per session totals computed once a day has ended,
    so the 30d, 90d and All ranges read summaries plus today.
- **A database.** `node:sqlite` is already used for rtk, so SQLite adds no
  dependency. It would hold parsed calls and prompts per session. Decide whether it
  is a cache that can be deleted and rebuilt from transcripts, or the only copy of
  history Claude Code has deleted.
- **Keeping history past `cleanupPeriodDays`.** If the dashboard should show more than
  30 days, it has to store its own copy, as summaries or in a database. Decide
  whether that is wanted.
- **The unchecked folders.** Confirm whether `setup/` and `changes/` are pruned, or
  grow one file per change for ever.
