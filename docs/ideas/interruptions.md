# Interruptions per prompt

Count the times the user stopped the model mid-turn or rejected a tool call, as a
measure of friction. Recorded on 2026-10-10.

## Why

An interruption usually means the model went the wrong way. Interruptions per typed
prompt is a setup metric that does not depend on cost. A CLAUDE.md rule that works
should lower it. That makes it a candidate row for the Setup changes before/after
table, next to context at session start.

## What exists

- Claude Code writes a user line with the text `[Request interrupted by user]` when a
  turn is stopped, and `[Request interrupted by user for tool use]` when a tool call
  is rejected at its permission prompt. The transcripts on this machine held 120 and
  26 on 2026-10-10.
- `lib/extract.js` records typed prompts. It does not record interruptions.
- `lib/efficiency.js` already excludes interrupted prompts from cost per prompt.

## Open questions

- Whether a rejected tool call counts the same as a stopped turn. A rejection can be
  the user being careful, not the model being wrong.
- Whether an interruption followed at once by a new prompt is a correction, and
  whether that difference can be read from the transcript.
- Where it shows: a Setup changes table row, a column in the Today table, or both.
