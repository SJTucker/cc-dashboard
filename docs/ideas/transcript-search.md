# Search past sessions

Full-text search over typed prompts, and maybe replies, across all sessions, with a
link to each matching session. Recorded on 2026-10-10, from the second round of
research. claude-code-log, claude-statistics, opcode and
claude-code-command-center all have a transcript viewer or search.

## Why

"Which session did I fix the price parser in" has no answer on the page today. The
answer is in the transcripts, but only for 30 days, because Claude Code deletes older
ones (`cleanupPeriodDays`).

## What exists

- `transcripts.db` keeps usage rows past Claude Code's cleanup, but no prompt text.
- `lib/review.js` builds a digest of one transcript for Haiku.
- [All-time session drill-down](all-time-session-drill-down.md) is the list that a
  search result would open into.

## Open questions

- Storing prompt text in `transcripts.db`. SQLite's FTS5 would make the search fast,
  if `node:sqlite` builds include it. This needs a check.
- Whether to keep a copy of each raw transcript before Claude Code deletes it. That
  costs disk and holds tool output, which may include secrets.
- Search on prompts only, or on replies and tool calls too.
