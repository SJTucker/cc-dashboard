# Setup script for new installs

Investigate a script that takes a new user from `git clone` to a working dashboard and
mod in one command. Asked for on 2026-10-08, as one of two steps toward getting the
project ready to ship. The other is [Docker](docker.md).

## What exists

`SETUP.md` lists the steps a new user runs by hand today:

- Check for macOS and Node 22.13 or later, with `node` on the PATH Claude Code sees.
- `npm install`, then `npm start`.
- Link the mod with `ln -s "$PWD/mod" ~/.claude/skills/cc-dashboard`, run from the
  clone. Check it with `claude plugin validate`.
- Or, without the mod, edit the statusline script and add a `SessionEnd` hook to
  `~/.claude/settings.json` by hand.
- Run the "Check it works" checklist.

## Open questions

- **Language.** Node is already required, so a `bin/setup` Node script needs nothing
  new. A shell script is easier to read before running. Decide which.
- **What it changes.** The minimum is: check the Node version, `npm install`, create
  the mod symlink, and run `claude plugin validate`. Decide whether it also starts the
  server, and whether it offers the "Without the mod" route, which edits
  `settings.json`.
- **Safe to run twice.** An existing symlink that points at this clone is left alone.
  A symlink or folder at `~/.claude/skills/cc-dashboard` that points elsewhere stops
  the script with a message, and is never replaced silently.
- **`CLAUDE_CONFIG_DIR`.** The link goes under `$CLAUDE_CONFIG_DIR/skills/` when that
  is set.
- **Keeping the server running.** Whether to offer a launchd agent so the dashboard
  starts at login, and how to remove it.
- **Uninstall.** A matching step that removes the symlink and any launchd agent, and
  says that `~/.claude/cc-dashboard/` is left in place.
- **Checks at the end.** Run the same checks as SETUP.md's "Check it works", and print
  which ones passed.
- **Docs.** SETUP.md would lead with the script and keep the manual steps below it.
  The CLAUDE.md rule then also covers the script, because a new path or variable must
  change both.
