# Subagent output may be undercounted

Check whether subagent calls since Claude Code 2.1.280 record the usage from the
start of the response stream instead of the final usage. If they do, every panel
undercounts subagent output and cost. Found on 2026-10-13 while building the
thinking share.

## What was measured

Over the deduped calls in `transcripts.db` on 2026-10-13, Claude Code 2.1.280 and
later:

- 26,850 calls have a `usage` object with only `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`,
  `output_tokens`, `service_tier` and `inference_geo`. They have no
  `output_tokens_details`, `iterations` or `speed`. 26,838 of them are subagent
  (sidechain) calls.
- Their `output_tokens` has a median of 8 and a p90 of 20, and sums to 293k tokens.
  Calls with the full usage shape have a median of 373.
- Before 2.1.280 a few hundred calls had the short shape.

## What exists

- `addCall` in `lib/extract.js` keeps the line with the most `output_tokens` for a
  response, so a later line with the final usage would win if one were written.
- The thinking share leaves these calls out, and the Thinking share card shows what
  share of calls it covers.

## Open questions

- Whether the subagent transcript holds a later line for the same response with
  the final usage, under a different `requestId` or message id.
- Whether the short usage shape comes from one subagent path (for example
  background agents or forks) or from all of them.
- If output is undercounted, whether the true figure can be recovered from the
  transcript, or only noted on the page.
