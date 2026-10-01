# Record setup changes automatically

Record edits to the Claude Code setup as they happen, so the Setup changes panels get
their markers without anyone editing `changes.json` by hand. The setup includes
`CLAUDE.md` files, rules, settings, hooks, skills and the rtk config. Asked for on
2026-10-01.

## Where markers come from now

`lib/changes.js` merges three sources:

- **Plugin installs:** read from `installedAt` in `plugins/installed_plugins.json`.
- **The first call to a new model:** found in the transcripts.
- **Everything else:** a hand-written list in `changes.json`. That covers `CLAUDE.md`
  edits, hooks, skills, rtk config, `/effort` and other settings.

The README's "Extending it" list already names the gap: "a Claude Code hook on edits
to `~/.claude/settings.json`, `CLAUDE.md` or skills could add an entry". The
dashboard only reads `changes.json`. Any write would belong to the hook, not the
dashboard.

## Two ways to catch a change

- **A `PostToolUse` hook on `Edit`, `Write` and `MultiEdit`.** The hook reads the tool
  call's JSON on stdin and checks `tool_input.file_path` against a list of setup
  paths. On a match it appends an entry with the time, a `kind` taken from the path,
  and a label. This catches only edits that Claude Code makes. Edits made in an
  editor, by `claude plugin`, or through `/config` are missed.
- **A snapshot that is compared on each scan or session start.** Store a hash and
  mtime for each setup file, and record an entry when either one differs from the
  last snapshot. A `SessionStart` hook or the dashboard's scan could run the
  comparison. This catches edits from any source. The entry's time is when the
  change was found, which can be hours after the edit. The file's mtime gives the
  real time.

Both could feed one file. The hook gives an exact time and the edit's text, and the
snapshot catches what the hook misses.

## Open questions

- **Which paths count.** Candidates: `~/.claude/CLAUDE.md` and each project's
  `CLAUDE.md`, `~/.claude/rules/`, `~/.claude/settings.json` and
  `settings.local.json`, `~/.claude/skills/*/SKILL.md`, `~/.claude/agents/`, hook
  scripts named in settings, the statusline script, and `~/.config/rtk/config.toml`.
- **Mapping a path to `kind`.** `CLAUDE.md` and rules map to `claude-md`, skills to
  `skill`, rtk config to `rtk`. A `settings.json` edit is `hook` when it changes the
  `hooks` block and `config` otherwise, so the hook would need to compare JSON.
- **Labels.** A hook knows which file changed, not why. Options: the file name alone;
  the first changed line from `tool_input.new_string`; or a label filled in later by
  hand.
- **Noise.** One session can edit `CLAUDE.md` ten times. Entries could merge per file
  per session, or per file per hour, so one change of mind is one marker. Each marker
  also widens the "another change within 7 days" overlap the panels report.
- **Where to write.** Appending to `changes.json` mixes generated entries with
  hand-written ones. A separate file, such as `changes.auto.json`, keeps the
  hand-written file clean. `lib/changes.js` would then read both, and a hand entry
  for the same change would replace the generated one.
- **Concurrent writes.** Several Claude Code sessions run at once here. The hook
  needs an append that two sessions cannot interleave, such as JSON Lines with one
  `appendFileSync` per entry.
- **Changes that are not file edits.** `/effort` and `/model` are typed commands. A
  `UserPromptSubmit` hook could see them. Whether Claude Code also has a hook event
  for settings changes needs checking against the current hooks documentation.
- **Install and scope.** The hook has to live in the user's `~/.claude/settings.json`
  to see edits from every project. Decide whether the dashboard ships the hook script
  in `bin/` the way it ships `bin/record-statusline`, plus a README step to install it.
