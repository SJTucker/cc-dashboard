# What fills the context

A table of the tool results that put the most tokens into context in the range: the
largest single results, and the files read most often in one session. Recorded on
2026-10-10.

## Why

Session reviews ask Haiku to spot large tool output and repeated reads one session at
a time. A deterministic table over the whole range would show the patterns that
repeat across sessions, such as one generated file read in every session, or one test
command whose output is always large. The fix for those is a rule or an rtk filter,
and the Setup changes panel can then show whether it worked.

## What exists

- Tool use rows from `lib/extract.js` hold `name` and `detail` (the Bash command or
  file name). They hold no result size.
- `lib/efficiency.js` estimates main-thread Bash result size from the context delta
  between calls.
- `lib/review.js` marks results over 10,000 characters as `LARGE OUTPUT` in the
  digest.

## Rules from token-dashboard

Found in the second round on 2026-10-10. token-dashboard (`nateherkai/token-dashboard`)
gives waste tips from fixed rules, with no model call: repeated reads of one file,
oversized tool results, and a low cache hit rate. It also draws tool and file heatmaps
and lists the most-touched files per project. Fixed rules cost nothing per session,
so they could run on every session, where Haiku reviews run on at most 3 per pass.

## Open questions

- Storing the result length per tool use changes `lib/extract.js` and raises
  `EXTRACT_VERSION`.
- Result text length or the context delta of the next call. The delta counts what
  the model saw. The length is simpler and works for subagents.
- Grouping key: the file path for Read, the command's first two words for Bash.
- Reads of the same file after an Edit of that file are expected. Count only reads
  with no edit between them.
