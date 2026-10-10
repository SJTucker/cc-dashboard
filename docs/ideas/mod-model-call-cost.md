# Count the mod's own model calls

Record the tokens and cost of the Haiku calls the mod makes, so the dashboard's
totals include them. Recorded on 2026-10-10.

## Why

The README says in four places that the mod's Haiku calls write no transcript line,
so the totals leave out their cost. Those calls are session reviews, release
verdicts and setup change labels. A user who wants to know what the dashboard costs
to run has no number.

## What exists

- `mod/hooks/register.ts` calls `$.model.complete({ model: 'haiku', ... })` for
  release verdicts and session reviews, and for setup change labels.
- `bin/review-session` and `bin/judge-updates` record the replies.

## Open questions

- Whether the reply from `$.model.complete` carries token usage. If it does not, the
  only option is an estimate from the prompt and reply lengths.
- Where the rows go: a `mod_calls` table in `transcripts.db`, so they survive and
  join the All range.
- How they show: a separate "dashboard overhead" line, or folded into the totals with
  a model of their own. Folding them in changes numbers users already compare
  against `/cost`.
