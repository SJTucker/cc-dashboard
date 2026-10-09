# Same-week model comparison

When two models run in the same week, compare them side by side: cost per prompt,
calls per prompt, and output and thinking tokens per call. Moved from README
"Extending it" on 2026-10-09.

## Why the same week

Inside one week the calendar and the setup are the same for both models. Comparing
this month with last month cannot give that.

## What exists

- Each call record in `efficiency.calls` (built by `aggregate` in
  `lib/aggregate.js`) carries `model`, `output`, `cost` and `tools`.
- Prompt records carry no model. A prompt's model has to come from its calls.
- `lib/efficiency.js` compares windows before and after a setup change. It has no
  comparison across models.

## Open questions

- How many calls each model needs in the week before a comparison is shown.
- How to count a prompt whose calls used more than one model, for example a
  subagent on Haiku.
- Where it shows: a Setup changes style before/after panel, or a table.
