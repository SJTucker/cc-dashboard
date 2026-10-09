# Cost per unit of work

Weekly spend divided by commits, or by Edit and Write calls. Moved from README
"Extending it" on 2026-10-09.

## What exists

- Cost per prompt exists in the per-prompt statistics of `lib/efficiency.js`.
- Edited lines per session are collected (`linesBySession` in `lib/aggregate.js`)
  and shown in the Lines column of the live sessions table.
- Nothing runs `git`. Counting commits needs `git log` in each session's `cwd`.

## Open questions

- Counting each repository once, because worktrees share history.
- The day-to-day values swing with a coefficient of variation near 0.7. Decide
  whether to show weekly values only, and how to label the result as noisy.
- Whether commits or Edit and Write calls is the better unit.
