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
| `cc-dashboard/setup/` | the mod | 18 files, 136 KB | No. One snapshot per watched setup file, rewritten in place, so it grows only when a new file is watched |
| `cc-dashboard/changes/` | the mod | 0 files | No. One file per session that changed setup. Each file is small |
| `records.json`, `prices.json`, `updates.json` | the server, `bin/judge-updates` | under 5 KB each | One file each, rewritten in place |

The transcripts are the only large data.

## Scan cost, measured 2026-10-08

Each range was timed with `scanUsage` in a fresh `node` process, with the OS file
cache warm.

| Range | Time | Files read |
|---|---|---|
| Today | 71 ms | about 20, the rest skipped by mtime |
| 7d | 0.85 s | files modified in the last 7 days |
| 30d, 90d, All | 3.5 s each | all 1441 files, 1.55 GB |

- The three long ranges read the same files, because no transcript is older than
  30 days. `cleanupPeriodDays` is unset, so the default of 30 applies.
- Reading every line through `forEachLine` takes 1.8 s. `JSON.parse` adds 1.5 s.
  `scanUsage`'s own logic takes about 0.1 s. Only reading fewer bytes makes the scan
  faster.
- Bytes by line kind: user lines carrying a `tool_result` 814 MB, `attachment`
  382 MB, assistant lines with usage 280 MB, typed prompts 57 MB. Subagent files
  hold 1.1 GB of the 1.55 GB.
- Walking all 1441 files and calling `statSync` on each takes 17 ms.
- The all-history scan result is about 22 MB on the heap after `gc()`. `server.js`
  caches 30d, 90d and All separately, so it holds three copies of the same data.
- Files modified in the last 6 hours: 21 files, 23 MB. In the last 24 hours: 48 files,
  36 MB. The largest single file is 39 MB, a subagent transcript.

## Decisions

- **Keep history past `cleanupPeriodDays`, in SQLite.** Decided on 2026-10-08. The
  database becomes the only copy of any transcript Claude Code has deleted.
- **Split old files from live files.** A transcript last modified before today's
  midnight is old. Its rows are extracted once, in full, and stored in SQLite under
  its path, size and mtime. Every other transcript is live and is parsed in full on
  each refresh. That costs about 2 ms per MB, so 50 to 80 ms on the sizes above.
- **Size and mtime decide which side a file is on.** When a stored file's size or
  mtime no longer matches the stored values, the server ignores its stored rows and
  treats the file as live. When the file is old again, its rows are replaced. This
  covers `--resume` appending to an ended session, subagent files that finish late,
  and crashed sessions.
- **No byte-offset reads.** Every file is read from the start. A file enters the
  store only after it stops changing, so a streamed response is never stored half
  written. `lib/scan.js` writes one line per content block, with `output_tokens`
  growing across the lines of one response. An offset-based reader would have to
  hold back the last unfinished group to avoid counting that response twice.
- **No hook trigger.** `session.end` does not fire on a crash, `kill -9` or shutdown.
  `--resume` appends to ended files. The Today poll already refreshes every 5 s, and
  the stat pass costs 17 ms. The mod's `session.end` also has a 1.5 s budget for
  every hook together (`mod/hooks/register.ts:22`).
- **Rows store tokens, not cost.** Cost and model family are computed when rows are
  aggregated. A price change then drops the aggregates only (`clearScans` in
  `server.js`).
- **Session state is stored as per-file summaries.** Every line carries `gitBranch`,
  so one row per line would be 400k+ rows. Each file instead stores, per session, its
  ordered branch list, newest branch, last `ai-title` and first typed prompt. These
  merge in file order, as the current scan does.

## Architecture

1. `lib/extract.js`: turns a transcript's lines into rows and per-session summaries.
   Row kinds: calls (tokens by kind, model, speed, sessionId, isSidechain, version,
   timestamp, tool ids), tool uses (id, name, detail, timestamp), tool errors
   (tool_use_id, text, timestamp), edits (tool_use_id, sessionId, lines added and
   removed, timestamp), prompts (uuid, sessionId, timestamp) and `cost-state`
   (sessionId, totalCostUSD).
2. `lib/aggregate.js`: the current `scanUsage` logic, run over rows. It applies the
   cutoff, hour and day buckets, pricing, the all-time-only `cost-state` rule and all
   cross-file dedupe (`message.id:requestId`, tool ids, prompt uuids, edit ids). The
   dedupe has to stay here: a resumed session can copy earlier lines into a new file,
   so one response can be in a stored file and a live one. `scanUsage` stays as a
   wrapper, so `server.js` and the tests do not change at first.
3. A comparison test of the old scan against the new one, on the fixtures in
   `test/scan.test.js` and on the real transcripts. Short ranges will gain titles and
   branches for idle sessions, because old files are no longer skipped by mtime.
   `meta.unreadableFiles` changes meaning. List both as expected differences.
4. `lib/store.js`: the SQLite store. A `files` table (path, size, mtime, extract
   version) and one table per row kind. Rows for a path are replaced in one
   transaction. Rows are never deleted when Claude Code deletes the transcript.
5. The server replaces its per-range scan caches with one refresh: stat every
   transcript, load stored rows for unchanged old files, extract changed old files
   into the store, parse live files, then aggregate each range from the same rows.
   Concurrent requests share one in-flight refresh, as `getCached` does now.
6. Remove `records.json` (`lib/records.js`) once the all-history aggregate is cheap.
   `records.json` exists only to avoid the all-history scan on every page load.

## Open questions

- **Node without `node:sqlite`.** `package.json` allows Node 18. `node:sqlite` needs
  Node 22.5 or later and prints an experimental warning (this machine runs 22.23.2).
  Either raise `engines`, or fall back to parsing every file on disk, as today, with
  no history past 30 days.
- **Changing the extractor.** For a file still on disk, an extractor change can be
  handled by re-extracting it. Rows whose transcript is gone cannot be rebuilt, so
  each change to the row schema needs a migration of the stored rows. One option is
  to keep a gzipped copy of each old transcript beside the database, so every row can
  be rebuilt. That costs disk space, which is not yet measured.
- **Aggregation over a growing history.** About 110k rows per 30 days means about
  1.3M rows a year. Measure how long the All range takes to aggregate at that size.
  If it is too slow, compute it in SQL or keep daily totals for closed days.
- **Backup.** The database is the only copy of old history. Decide whether the
  dashboard should back it up, or whether that is left to the machine's backups.
- **`modelMarkers` in `lib/changes.js`.** Its "earliest call" rule assumes history
  starts at the oldest transcript on disk. Retained rows move that start back.
- **Measure before building:** aggregation time over 110k rows, the heap of one row
  set, and the cold start with an existing database.
