# Subagent status line in Doing now

Asked for on 2026-10-14. Claude Code's agent list, below the prompt, shows one line
per running subagent: its type, a short status such as "Running deliberate breaks on
…", the elapsed time and the tokens received. The Live sessions table's Doing now
column shows only "1 subagent". The idea is to show that status text there.

## What the dashboard has today

- `doingNow` in `public/session-groups.mjs` builds the column from the running
  tool's name and `activity.subagents`, a count.
- The count comes from the mod: `subagentCount` in `mod/hooks/register.ts` writes
  `subagents` into `<cfg>/cc-dashboard/activity/<session id>.json`, which
  `lib/activity.js` reads.

## Where the text might come from (checked 2026-10-14)

- Each subagent has a `<session>/subagents/agent-<id>.meta.json` next to its
  transcript. It holds `agentType`, `description` (the Agent tool's 3-5 word
  description, for example "Implement Task 4: file warnings, markers"), `model` and
  `requestShape`. This is readable today.
- The status text in the screenshot was not found as a line of its own in any
  transcript or `meta.json`. The words appeared only inside plan text and an
  assistant message. Believed: Claude Code generates the status line in memory and
  does not write it to disk.

## Open questions

- Does the mod engine expose the live status line, for example on a subagent event
  or through `ui`? If so, the mod can write it into the activity file beside
  `subagents`.
- If it does not, is `description` from `meta.json` good enough? It is fixed at
  spawn and does not change as the subagent works.
- How several subagents fit in the column: one line each, the newest only, or a count
  with the text in a tooltip. `doingNow` leaves out the tool's detail because a long
  value widened the column and moved the table on every 5 s poll. The same problem
  applies here.
