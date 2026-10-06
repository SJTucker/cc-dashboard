# Subagent permission prompts

Show in the Running now table when a subagent waits on a permission prompt. Raised
in the phase 3 review of Live sessions on 2026-10-06.

## What was asked for

- **A subagent's prompt counts.** When a subagent's tool call opens a permission
  dialog, the session waits on the user. Running now shows that session as working,
  or, after 10 minutes without updates, with no state.
- **The reviewer's fix sketch**, written for the needs approval state that the mod
  had then:
  - The `tool.check` hook in `mod/hooks/register.ts` accepts an `ask` that carries
    an `agentId`, as long as it also carries a `tool_use_id`.
  - The `finally` block of that subagent's `tool.call` clears the ask.
  - A per-session `turnOpen` flag is set on `turn.start` and cleared on the main
    loop's `turn.complete`.
  - The main loop's `turn.complete` keeps pending subagent asks, because a
    background subagent can still be waiting on its dialog after the main turn ends.

## Where the work happens now

- **No approval state.** Commit `refactor: drop the approval state` removed the
  `tool.check` hook from `mod/hooks/register.ts`, and removed `approval` from
  `STATES` in `lib/activity.js` and from `ACTIVITY_STATES` in
  `public/session-groups.js`. `tool.check` answers `ask` before the permission mode
  settles the call. In auto mode the classifier then allows the tool with no event,
  so "needs approval" showed for the whole run of an allowed tool.
- **Subagent events.** A subagent's `tool.call` carries its `agentId`. The mod's
  `tool.call` hook only rewrites the file when such a call returns, so that
  `subagents` and `updatedAt` stay current.

## Open questions

- **The permission mode.** In Claude Code 2.1.291 a mod cannot read the session's
  permission mode. `ToolCheckInput` and `ToolCheckResult` carry no mode, `$.session`
  has no mode method, and `AgentSpawnInput.permissionMode` is only seen when a
  subagent starts. Without the mode, an `ask` does not tell whether a dialog opens.
  The main loop's approval state needs the same answer first.
- **Which modes show a dialog.** Of `PermissionMode` (`default`, `acceptEdits`,
  `plan`, `auto`, `dontAsk`, `bypassPermissions`), `auto` hands an ask to the
  classifier, `dontAsk` denies it, and `bypassPermissions` skips the check. Confirm
  that `default`, `acceptEdits` and `plan` are the modes that open a dialog.
- **A subagent with its own mode.** An agent definition's `permissionMode` can
  override the parent's. The mode that decides a subagent's ask may differ from the
  session's.
