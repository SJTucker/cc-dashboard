# Check: stored rows when a transcript is rewritten

Find out whether Claude Code ever rewrites a transcript with fewer lines, and if it
does, keep the stored rows that the rewrite dropped. Recorded on 2026-10-10, from the
second round of research.

## Why

Claude-Code-Usage-Monitor issue #226 reports that transcripts are rewritten on resume
or compaction, so messages vanish and historical totals drift. The reporter proposes
an append-only store keyed by message uuid. This is one user's report and has not
been checked here.

## What exists

- `lib/rowstore.js` reads a transcript again when its size or mtime changes, and the
  new rows replace the old ones. A rewrite that drops lines would drop their rows,
  including from `transcripts.db` once the file settles.
- `lib/aggregate.js` dedupes calls on `message.id:requestId` across files, so a
  response copied into another session file is counted once.

## Open questions

- How to check: compare stored row counts per file against a fresh extract, over
  a few days that include resumes and compactions.
- If rewrites happen, whether to merge rows by key instead of replacing them. That
  would also keep a call whose line Claude Code moved to another file.
