# Guard: stored rows when a transcript loses lines

Warn when a transcript that is read again has lost calls the row store held, because
the row store would drop them. Recorded on 2026-10-10, after checking a user report.

## The report

Claude-Code-Usage-Monitor issue #226 (opened 2026-07-06, no Claude Code version, no
comments) says resume and compaction rewrite session transcripts. Between two scans
of one file, 5 assistant messages vanished and the mtime changed. The report gives no
mechanism and no reproduction.

## Checked on 2026-10-10, Claude Code 2.1.296: not reproduced

- **Stored rows against the files on disk.** `transcripts.db` held 1,845 files, 1,805
  of them still on disk, with 54,806 call keys. A fresh `extractFile` of each file on
  disk found no file missing a key the database holds, and no file smaller than its
  stored size. 4 files had grown, with 21 new keys, which are live sessions appending.
- **A throwaway session.** `claude -p --model haiku`, then three `--resume` runs: a
  second prompt, `/compact`, and a third prompt after the compaction. Each step wrote
  to the same file, and each earlier version of the file was an exact byte prefix of
  the next. `/compact` appended a `compact_boundary` line and a compact summary line
  and removed nothing.
- **Not tested:** a long interactive session, auto-compaction, an interactive
  `/resume`, subagent files, and older Claude Code versions.

## What the row store would do

`load` in `lib/rowstore.js` reads a file again when its size or mtime changes and
replaces its rows, and `put` in `lib/store.js` writes them with `INSERT OR REPLACE`.
A file that lost lines after it was stored would lose those calls from the database
at the next refresh. A deleted file keeps its rows (`reconcileMissing`), and a failed
read keeps the previous rows.

## Possible guard

When `load` replaces an entry, compare the new call keys with the old ones, and log a
warning naming the file and the count when keys are missing. That costs one set
comparison per changed file and would catch the untested cases if they happen.

## Open questions

- Warn only, or also keep the old rows by merging on key.
- Whether a warning in the server log is enough, or the page should show it.
