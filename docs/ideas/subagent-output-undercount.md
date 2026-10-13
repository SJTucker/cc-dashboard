# Subagent output is undercounted

In interactive sessions on Claude Code 2.1.280 and later, the last transcript line
of most subagent responses carries the usage from the start of the response stream.
Its `output_tokens` is a few tokens, and the final usage is never written. Every
panel undercounts subagent output and cost. Found on 2026-10-13 while building the
thinking share, and confirmed the same day.

## How a response is written

Claude Code writes one transcript line per content block of a response. Every
line repeats the response's `message.id`, `requestId` and `usage`.

- Lines written while the response streams have `stop_reason: null` and the
  stream-start usage: the final input-side counts, and an `output_tokens` of a few
  tokens. Their `usage` has no `output_tokens_details`, `iterations` or `speed`.
- The line for the last block should carry the final usage, with `stop_reason` set
  and the full `usage` shape.
- In an affected response, every line has `stop_reason: null`. No other line in
  any transcript holds that response's final usage.

`addCall` in `lib/extract.js` keeps the line with the most `output_tokens`, so a
response that has its final line is counted correctly.

## What was measured

Over every transcript on this machine on 2026-10-13, Claude Code 2.1.280 and later:

- 27,134 subagent responses, from 2026-09-22 to 2026-10-13, have no final line.
  4,281 subagent responses wrote stream-start lines and then a final line, and are
  counted correctly. 12 main-thread responses have no final line.
- The responses with no final line record 0.3M output tokens ($4). Their visible
  text and tool input alone come to about 6.5M tokens at 4 characters per token
  ($88). At the main thread's 1.7 characters per recorded output token, which
  includes thinking, they come to about 15.2M tokens ($208). The dashboard's 30-day
  total was about $3,150.
- Example: a response that called Bash with 336 characters of input records 5
  output tokens. A response whose `SubagentHandback` input is 2,408 characters
  records 25.
- They span every model (Sonnet 5.5 13,178, Opus 5.5 7,637, Sonnet 5 4,445,
  Haiku 4.5 1,049, others under 500) and every subagent type
  (`general-purpose` 28,028, `Explore` 1,970, `fork` 123, `Plan` 22).
- The `requestShape` in an agent's `.meta.json` does not decide it. Background
  agents lack the final line on 26,800 of 32,672 responses, and foreground agents
  on 377 of 441.

## Interactive sessions only

Probes on 2026-10-13, Claude Code 2.1.296, Haiku:

- `claude -p` with a foreground subagent, and `claude -p` with a background
  subagent: every subagent response got its final line.
- An interactive session (driven with `expect`) with a background subagent: the
  last response, a `SubagentHandback` call, has no final line. The transcript
  records 24 output tokens. The real figure was 163.

## The mod can see the real usage

A mod `turn.step` hook fires for every model request, the main thread's and each
subagent's (`e.agentId`). `await next(e)` resolves to the whole response, with
`stopReason` and `usage` (`input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `model`). A throwaway
probe mod loaded with `claude --plugin-dir` logged these in all three probes:

- Where the transcript has a final line, the `turn.step` output matches it exactly
  (154, 105, 56, 242).
- Where it does not, `turn.step` has the real output (163 against the
  transcript's 24).
- `TurnStepResult` carries no message id or request id. The streamed `tool` chunks
  carry each call's `tool_use_id`, but a step that only writes text has none.
- The input-side counts (`input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`) are final at stream start. They are identical in the
  stream-start lines, the final line and `turn.step`. With the `agentId`, they
  identify a response.
- The probe mod is in the session scratchpad, not in the repo.

## Built

The mod's `turn.step` hook writes each subagent step's usage to
`<cfg>/cc-dashboard/agent-usage/<agentId>.json`. The row store reads those files
(`lib/agent-steps.js`), the extract marks a response with no final line `noFinal`
and carries its `agentId`, and `record()` in `lib/aggregate.js` prices such a
response at the recorded output when the agent and the input-side counts match.
`meta.noFinalCalls` and `meta.noFinalCorrected` count the responses with no final
line and the ones corrected.

Reporting the transcript bug to Anthropic would fix new interactive sessions at the
source.

## Open questions

- Whether to estimate the 27,134 responses recorded before the fix, and how to label
  an estimate on the page.
- Whether `noFinalCalls` without `noFinalCorrected` stays near zero in practice. A
  step that retried inside one request matches nothing.
