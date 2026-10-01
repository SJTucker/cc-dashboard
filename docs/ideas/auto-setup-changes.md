# Record setup changes automatically

Record edits to the Claude Code setup as they happen, so the Setup changes panels get
their markers without anyone editing `changes.json` by hand. The setup includes
`CLAUDE.md` files, rules, settings, hooks, skills and the rtk config. Asked for on
2026-10-01.

The recording goes in the dashboard's Claude Code mod in `mod/`, which already records
plan usage and session ends. Claude Code updates are a separate idea:
[claude-code-updates.md](claude-code-updates.md).

## Where markers come from now

`lib/changes.js` merges three sources:

- **Plugin installs:** read from `installedAt` in `plugins/installed_plugins.json`.
- **The first call to a new model:** found in the transcripts.
- **Everything else:** a hand-written list in `changes.json`. That covers `CLAUDE.md`
  edits, hooks, skills, rtk config, `/effort` and other settings.

## Events the mod can use

Claude Code 2.1.287 has these events. The first three are classic hook events. A
settings hook in `settings.json` receives them, but an installed mod does not:
Claude Code's built-in `cc-plugin-sec-default` skips every `classic.*` hook of an
installed plugin. Recording them needs a settings hook that runs a `bin/` script, or
a Claude Code release that lets a mod see them. The last three are engine events,
which the mod receives.

- **`ConfigChange`** fires when a settings file or a skill changes. It carries
  `source` (`user_settings`, `project_settings`, `local_settings`,
  `policy_settings` or `skills`) and `file_path`.
- **`InstructionsLoaded`** fires when a `CLAUDE.md` or rule file loads. It carries
  `file_path`, `memory_type` (`User`, `Project`, `Local` or `Managed`) and
  `load_reason`. Comparing a hash of the file with the last one stored catches an
  edit made in any editor, at the next session that loads it.
- **`PostModelSwitch`** fires on a model change. It carries `from_model`, `to_model`
  and `source` (`command`, `picker`, `sdk`, `auto` or `resume`). `auto` is a
  fallback, not the user's choice, so it gets no marker.
- **`tool.call` on Edit and Write** sees Claude Code's own edits as they happen, with
  the file path and the edit's text.
- **Effort.** Hooks that fire inside a tool call carry `effort.level`. The mod can
  store the last level seen and record a marker when it changes.
- **`session.start`** can compare a stored hash and mtime per setup file with the
  files on disk, and catch what no event covers. `~/.config/rtk/config.toml` is the
  known case.

## Writing markers

- `$.fs.write` replaces a whole file. It cannot append, and it cannot rename. Several
  sessions run at once here, so a shared file would lose entries. Each session writes
  its own file, for example `~/.claude/cc-dashboard/changes/<session_id>.json`, the
  same pattern as `cc-dashboard/sessions/`.
- `lib/changes.js` reads every file in that folder beside `changes.json`. A
  hand-written entry for the same change replaces the generated one.
- The snapshot of setup file hashes is kept in `$.store`, which lasts across
  sessions.

## Kinds

- `CLAUDE.md` and rules map to `claude-md`.
- Skills map to `skill`.
- The rtk config maps to `rtk`.
- A `settings.json` change is `hook` when its `hooks` block changed and `config`
  otherwise. The mod compares the old and new JSON, from the snapshot in `$.store`.
- A model switch is `model`. An effort change is `effort`.

## Open questions

- **Labels.** The mod knows which file changed, not why. Options: the file name
  alone; the first changed line from the edit's text; or a label filled in later by
  hand.
- **Noise.** One session can edit `CLAUDE.md` ten times. Entries could merge per file
  per session, or per file per hour, so one change of mind is one marker. Each marker
  also widens the "another change within 7 days" overlap the panels report.
- **Which paths count.** Candidates: `~/.claude/CLAUDE.md` and each project's
  `CLAUDE.md`, `~/.claude/rules/`, `~/.claude/settings.json` and
  `settings.local.json`, `~/.claude/skills/*/SKILL.md`, `~/.claude/agents/`, hook
  scripts named in settings, the statusline script, and `~/.config/rtk/config.toml`.
- **Model markers twice.** `lib/changes.js` already finds the first call to a new
  model in the transcripts. A `PostModelSwitch` marker would duplicate it unless one
  of the two is dropped.
