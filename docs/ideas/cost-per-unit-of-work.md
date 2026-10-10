# Cost per unit of work

Weekly spend divided by commits, or by Edit and Write calls. Moved from README
"Extending it" on 2026-10-09.

## What exists

- Cost per prompt exists in the per-prompt statistics of `lib/efficiency.js`.
- Edited lines per session are collected (`linesBySession` in `lib/aggregate.js`)
  and shown in the Lines column of the live sessions table.
- Nothing runs `git`. Counting commits needs `git log` in each session's `cwd`.

## How other tools count commits

Found in the second round on 2026-10-10.

- Claude Code's OpenTelemetry export has `claude_code.commit.count` and
  `claude_code.pull_request.count` metrics. The transcripts carry no such count.
- Anthropic's Teams analytics marks a merged pull request as assisted when a session
  edited matching lines in the same files, from 21 days before the merge to 2 days
  after. A local version could match `git log` diffs against the Edit and Write rows.
- claude-code-command-center parses a ticket id from the branch name to give cost per
  ticket. The dashboard already has each session's branch, so cost per branch needs
  no `git` call.

## Open questions

- Counting each repository once, because worktrees share history.
- The day-to-day values swing with a coefficient of variation near 0.7. Decide
  whether to show weekly values only, and how to label the result as noisy.
- Whether commits or Edit and Write calls is the better unit.
