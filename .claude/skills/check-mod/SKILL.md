---
name: check-mod
description: Check a change to mod/ live in a real Claude Code session. Use before saying a mod hook, command or session.start step works, and to check a worktree's mod before merge. Covers driving an interactive session with expect, loading a renamed probe copy with --plugin-dir, telling its output apart from the installed mod, and headless checks of tool.call.
---

# Check the mod live

`claude plugin test mod` runs the mod's unit tests, and its test harness hides some
engine behaviour (see `docs/claude-code-facts.md`). Use this skill when the claim
is about what the mod does in a real session.

## 1. Start an interactive session with expect

The mod's interactive-only work (`checkSetup`, session reviews) runs only when
`session.start` has `isInteractive: true`, so `claude -p` never triggers it.
`/usr/bin/expect` can start a real interactive session from the Bash tool. Write
`start.exp` in the scratchpad:

```
set timeout 60
spawn env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT claude
sleep 25
send "/exit\r"
expect eof
```

Run it from the repo root with `expect <scratchpad>/start.exp`.

- The 25 s sleep lets the session start and the mod's `clock.after(0)` work finish,
  including a Haiku label call.
- The `env -u` list matters. A child that inherits this session's environment saves
  no transcript ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
  marker").
- Run from the repo root, which is already trusted. In an untrusted folder the trust
  dialog defaults to "No, exit", so the first Enter quits. Accepting trust writes to
  `~/.claude.json`, so don't.
- `claude --resume <id>` works the same way and appends to the same transcript.

## 2. Check a worktree's mod before merge

Claude Code loads the installed mod from the main checkout, so a worktree's mod
changes need a probe copy.

1. Copy `mod/` to `<worktree>/mod-probe/`, inside the clone, so `scriptPath` still
   finds `<worktree>/bin`.
2. Rename `name` in the probe's `plugin.json` so it does not clash with the installed
   mod.
3. Rename the `limitBand` atom owner: `{ plugin: 'cc-dashboard' }` in the probe's
   `register.ts` and the key in `types/cc-dashboard.d.ts`. Otherwise validate fails
   with "only a value's owner writes it".
4. Point the probe's writes at a different folder, for example `activity-probe/` in
   place of `activity/`. Anything in that folder came from the probe. The installed
   mod still loads beside the probe and cannot be turned off without changing
   `~/.claude`.
5. A mod command in a probe needs `$.command.register` inside `session.start`, or
   Claude Code answers "Unknown command".
6. Load it in the expect script's `spawn` line with `claude --plugin-dir <worktree>/mod-probe`.

Live checks need the real `~/.claude`. A temp `CLAUDE_CONFIG_DIR` cannot take a turn,
because the login lives in the keychain (`claude auth status` there reports
`loggedIn: false`). Back up `~/.claude/cc-dashboard/settings.json` first and confirm
it is unchanged afterwards with `cmp`.

Delete `mod-probe/` when the check is done.

## 3. Headless checks without session.start

A check that needs no `session.start`, such as a background subagent's `tool.call`,
can run headless. From the repo root, with the same `env -u` list:

```bash
claude -p --plugin-dir <worktree>/mod-probe \
  --allowedTools "Agent" "Write" "Bash(<exact command>:*)" \
  --output-format json "<prompt>"
```

Have the prompt start a `run_in_background` subagent, wait for it and print its
report. The subagent's transcript lands under `<project dir>/<session_id>/subagents/`.

Auto mode refuses `--dangerously-skip-permissions` on a spawned `claude`, and a
subagent cannot get it approved. A narrow `--allowedTools` list avoids the refusal.
Run the probe from the main thread once the owner has asked for the check.
