# Costliest prompts

List the prompts that cost the most in the range, each with its session, and open
one to see its calls, tool calls and result sizes. Recorded on 2026-10-10, from the
second round of research (token-dashboard ranks prompts this way).

## Why

Cost per prompt is a median in the Setup changes panel. The expensive prompts are
the outliers, and the median hides them. A ranked list shows which kinds of request
cost the most, such as "review the whole branch" or a prompt that started a long
subagent run.

## What exists

- `lib/efficiency.js` builds per-prompt records with cost, calls and tools for the
  Setup changes panel.
- Prompt rows hold no text. Only each session's `firstPrompt` keeps a preview
  (`promptPreview` in `lib/extract.js`).
- The Session reviews digest cuts each prompt to 400 characters.

## Open questions

- Storing a preview of every prompt in `transcripts.db`. It makes the database hold
  prompt text, which it does not today. SETUP.md and the README's "What it does and
  doesn't do" would need to say so.
- Whether a prompt's cost includes the subagent calls it started.
- How far the drill-down goes: calls only, or each tool call with its result size
  (each tool result's size is stored since extract version 9, see the What fills
  the context table in the Tool calls panel).
