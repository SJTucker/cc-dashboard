# Thinking tokens

Show how much of the output spend goes to thinking, from the
`usage.output_tokens_details.thinking_tokens` field of each call. Recorded on
2026-10-11, when the row store growth plan chose to keep that field in the database.

## What exists

- `transcripts.db` holds the full `usage` object of each call. On 2026-10-11,
  34,439 of 59,587 calls had `thinking_tokens`. On every one of those calls it was
  no larger than `output_tokens`. Across those calls it summed to 8.8M of 26.1M output
  tokens, about 34%.
- No code reads the field. `lib/aggregate.js` `record()` and `lib/pricing.js`
  `costForUsage()` read `output_tokens` only.
- The row store growth plan drops unused `usage` keys from rows in memory after they
  are written. A panel that reads `thinking_tokens` must add it to `slimUsage` in
  `lib/compact-rows.js` first.
- The database is the only copy once Claude Code deletes a transcript, so the field
  must stay in stored rows.
- [Same-week model comparison](same-week-model-comparison.md) lists thinking tokens
  per call as one of its measures.

## Open questions

- Why 25,148 calls carry no `thinking_tokens`: calls without thinking, older Claude
  Code versions, or particular models.
- Where it shows: a thinking share on the Daily cost chart, a column in the model
  mix, or only inside the same-week model comparison.
- Whether a change in thinking share should count as a setup change marker, for
  example after an effort level change.
