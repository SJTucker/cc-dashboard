# Lines of code over time

A panel on the Analysis tab with a chart of the lines of code added and the lines
deleted per day, following the range picker. Asked for on 2026-10-15.

## What exists

- `collectEdits` in `lib/extract.js` writes one `edits` row per Edit and Write
  result: `{ toolUseId, t, sessionId, added, removed }`. Each row has its own time,
  so the rows can be summed per day or per hour.
- `addEdits` in `lib/aggregate.js` sums them per session only (`linesBySession`). The
  Live sessions table's Lines column reads those sums. Nothing sums them per day.
- The daily buckets in `lib/aggregate.js` (`emptyBucket`) hold tokens and cost per
  day, and the Today range buckets by hour. Lines per day would be two more fields in
  that bucket.
- The [High score tab](high-score-tab.md) idea wants the record days for lines added
  and lines deleted, which reads the same daily sums.

## Open questions

- **Chart form.** Added above the axis and deleted below it, or two bars side by side
  per day. The chart must separate the two series by texture or position, not by
  colour alone (red-green colourblind owner). The Setup changes and Usage charts set
  the existing patterns.
- **What counts.** Edit and Write only, as Lines does today, or also NotebookEdit and
  lines changed through Bash (`sed -i`, `git apply`), which the transcripts do not
  measure. A Write of an existing file counts its whole content as added.
- **Per project.** One total, or a split by project or branch.
- **Subagents.** Subagent edits carry the parent's `sessionId`, so they are already in
  the totals. Whether the chart splits main and subagent edits.
- **History.** Rows from transcripts Claude Code deleted keep their stored `edits`,
  so the chart reaches back to the first stored day.
