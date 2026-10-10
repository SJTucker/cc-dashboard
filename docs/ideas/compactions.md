# Compactions

Count context compactions per day and per session, split by automatic and manual,
with the context size before and after each one. Recorded on 2026-10-10.

## What exists

- Claude Code writes a `system` line with subtype `compact_boundary` at each
  compaction. Its `compactMetadata` holds `trigger` (`manual` or `auto`),
  `preTokens`, `postTokens`, `cumulativeDroppedTokens` and `durationMs`. The
  transcripts on this machine held 14 such lines on 2026-10-10.
- `lib/review.js` puts `COMPACTED` into the session review digest. Nothing else reads
  the line. `lib/extract.js` skips compact summaries when it looks for prompts.

## What it could show

- Compactions per day, automatic and manual, as a count or a row in the Setup
  changes table. A Claude Code release that changes the auto-compact threshold would
  show as a step.
- Per session, in the Today table, a compaction count. Auto-compaction mid-task is a
  common cause of lost context and repeated reads.
- The time compaction took (`durationMs`), summed per day.

## Open questions

- Storing the metadata needs a new row kind in `lib/extract.js` and a raised
  `EXTRACT_VERSION`, which re-extracts stored rows. Stored rows from transcripts
  Claude Code has deleted would have no compactions.
- Whether the compaction call's own cost can be found. A compaction summary is a
  model call that may write no assistant line (see the note in `lib/aggregate.js`).
