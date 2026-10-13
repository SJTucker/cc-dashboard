# Plan limit band below the prompt

Show the plan limit warning ("⚠ Nearing your plan limit · Session 78% (resets in
3h 46m)") on the line under the prompt, above the status line's model line
("Opus 5.5 (1M context) | main"). Today it sits above the prompt, under the
"Waiting for N background agents" line. Asked for on 2026-10-13.

## Where it is drawn today

- The mod draws it with a `ui.render` hook on `{ component: 'AbovePrompt' }` in
  `mod/hooks/register.ts`. The text comes from `bandText` and `shownWindows` in
  `mod/hooks/limits.ts`. A Dismiss button (hotkey `d`) writes the dismissed levels
  to `<cfg>/cc-dashboard/limit-warnings.json`, which every session reads.

## What can draw under the prompt

On Claude Code 2.1.296 the terminal shows, from top to bottom: the `AbovePrompt`
slot, the prompt, the status line (`statusLine.command` output), then the hint
line ("auto mode on (shift+tab to cycle) · ← 1 agent").

- The mod engine's `RenderComponent` slots near the prompt are `AbovePrompt`,
  `PromptHint` (the hint line) and `SessionMode` (the mode labels at the right of
  the prompt footer). None of them sits between the prompt and the status line.
  `PromptHint` would put the band under the status line.
- The status line is the user's own script. `bin/cache-line` already adds a line to
  it (SETUP.md, "Cache countdown in the statusline"). A `bin/limit-line` run the
  same way, and printed first, would put the band exactly where it was asked for.

## Open questions

- **Dismissing.** A status line is text, so it has no button or hotkey. The status
  line could hide the levels `limit-warnings.json` already marks dismissed, with
  dismissal moved to a mod slash command, or kept as a hotkey on a smaller
  `AbovePrompt` element.
- **Shared logic.** `bandText` and `shownWindows` are TypeScript in the mod, which
  runs with no Node. A `bin/` script is Node. Either the logic moves to a file both
  can load, or it is written twice with a test that keeps the two equal.
- **Readings.** The band reads the session's rate limits as the mod sees them. The
  status line JSON carries `rate_limits` too (`bin/record-statusline` reads it).
  Check the two agree, including the reset time.
- **Both places or one.** Whether the `AbovePrompt` band goes away once the status
  line shows the warning, or stays for people without the status line step.
- **Refresh.** The status line is redrawn when Claude Code runs the script again, so
  a dismissal in another session shows only at the next redraw.
