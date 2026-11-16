# Same-week model comparison

When two models run in the same week, compare them side by side: cost per prompt,
calls per prompt, and output and thinking tokens per call. Moved from README
"Extending it" on 2026-10-09.

## Why the same week

Inside one week the calendar and the setup are the same for both models. Comparing
this month with last month cannot give that.

## What exists

- Each call record in `efficiency.calls` (built by `aggregate` in
  `lib/aggregate.js`) carries `model`, `output`, `thinking`, `cost` and `tools`.
  `thinking` is null for a call whose usage has no `thinking_tokens`, which is most
  subagent calls since Claude Code 2.1.280.
- Prompt records carry no model. A prompt's model has to come from its calls.
- `lib/efficiency.js` compares windows before and after a setup change. It has no
  comparison across models.

## Open questions

- How many calls each model needs in the week before a comparison is shown.
- How to count a prompt whose calls used more than one model, for example a
  subagent on Haiku.
- Where it shows: a Setup changes style before/after panel, or a table.

## Spike findings (2026-09-24)

A throwaway spike over the owner's transcripts and rtk history found:

- Session-start context (the first main-thread call's input plus cache tokens) does
  not depend on the task. It steps up when plugins or skills are installed. Two
  models in the same week differed by about 1.3K tokens on it, so a rise is setup,
  not model.
- Main-thread Bash result size dropped by about a third after an rtk config change,
  and rtk's own history agreed. Transcripts record the command before a hook
  rewrites it, so rtk's effect cannot be split out by command text.
- Model drift is best compared inside one week with both models running, not month
  against month.
- Cost per commit and cost per prompt are too noisy (coefficient of variation about
  0.7) to credit to a single change.
- `history.jsonl` timestamps are local time. Plugin `installedAt` values are UTC.
