# SETUP.md for new users

Write a `SETUP.md` that takes a new user from `git clone` to every panel working.
Asked for on 2026-10-07.

## What was asked for

- **Steps for someone else to run the project.** Cover the setup that lives outside
  this repo, such as installing the mod, as well as what is inside it.
- **Find what lives outside the repo.** An inventory on 2026-10-07 found the items
  below. Check each one against the code again before writing `SETUP.md`.
- **A rule that keeps `SETUP.md` current.** Asked for on 2026-10-08. Claude must
  update `SETUP.md` in the same change whenever that change alters what a new user
  needs. Examples: a new runtime requirement, a new environment variable, a new or
  removed file outside the repo, or a change to how the mod is installed.

## What a new user needs

### Runtime

- **Node 22 or later.** `lib/rtk.js` uses `node:sqlite`, which Node 22 added.
  `package.json` still says `>=18`. On Node 18 or 20 the server runs, and the rtk
  panels are hidden.
- **macOS for rtk's default path.** `lib/rtk.js` defaults to
  `~/Library/Application Support/rtk/history.db`. Other systems set `RTK_DB`.
- **`node` on the PATH that Claude Code sees.** The mod runs `bin/*` scripts through
  their `#!/usr/bin/env node` shebangs. The scripts need the exec bit.
- The server binds `127.0.0.1` only. The port is 3600, or `--port` / `PORT`.

### The mod

- **Install.** The README's only route is a symlink:
  `ln -s ~/code/cc-dashboard/mod ~/.claude/skills/cc-dashboard`. Then check it with
  `claude plugin validate ~/code/cc-dashboard/mod`. There is no marketplace file and
  no `claude plugin install` route.
- **`mod/` must stay beside `bin/`.** `scriptPath` in `mod/hooks/register.ts` follows
  the symlink to the checkout and runs `<repo>/bin/<name>`. A copy of `mod/` on its
  own finds no scripts.
- **Claude Code version.** No minimum is stated. The mod uses the function hooks API,
  which the README calls early access. It uses engine events only, because
  `cc-plugin-sec-default` skips `classic.*` hooks for installed plugins. It was last
  run on 2.1.292.
- **Network and model use.** The mod fetches
  `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, and calls
  Haiku through the user's Claude Code login. No API key is read.
- **What stays empty without the mod:** Plan usage "as of", Live sessions, the State
  and Doing now columns of Running now, Session reviews, Claude Code release markers,
  automatic setup-change markers, and subagent counts.
- **The route without the mod.** The README's "Without the mod" section pipes the
  statusline JSON to `bin/record-statusline` and adds a `SessionEnd` hook for
  `bin/record-session-end`. That route gives no reviews, activity, release markers or
  setup markers. Use one route, not both.

### Files outside the repo

`<cfg>` is `CLAUDE_CONFIG_DIR`, or `~/.claude`.

| Path | Override | Written by |
|---|---|---|
| `<cfg>/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR` | Claude Code |
| `~/.claude.json` | `CLAUDE_JSON` | Claude Code |
| `<cfg>/rate-limits.json` | `RATE_LIMITS_JSON` | `bin/record-statusline` |
| `<cfg>/cc-dashboard/sessions/` | `LIVE_SESSIONS_DIR` | `bin/record-statusline`, `bin/record-session-end` |
| `<cfg>/cc-dashboard/activity/` | none | the mod |
| `<cfg>/cc-dashboard/changes/`, `setup/` | none | the mod |
| `<cfg>/cc-dashboard/reviews/` | `REVIEWS_DIR` | `bin/review-session` |
| `<cfg>/cc-dashboard/updates.json` | `UPDATES_FILE` | `bin/judge-updates` |
| `<cfg>/cc-dashboard/records.json` | `RECORDS_FILE` | the server |
| `<cfg>/cc-dashboard/prices.json` | `PRICES_JSON` | the server, on Apply |
| `<cfg>/plugins/installed_plugins.json` | `CLAUDE_CONFIG_DIR` | Claude Code |
| `<repo>/changes.json` | `CHANGES_FILE` | the user, by hand |
| rtk `history.db` | `RTK_DB` | rtk |

### README gaps found by the inventory

- Node 22 is mentioned only in the optional rtk section.
- The symlink and statusline snippets hard-code `~/code/cc-dashboard`.
- The intro says "five small files, two dependencies" and one network request on
  Check prices. The repo has 15 `lib/` files and a mod, and the mod also fetches the
  changelog and calls Haiku. `package.json`'s description repeats the network claim.
- The environment variables are described in separate sections. No table lists them.

## Open questions

- **Where the update rule lives.** The repo has no project `CLAUDE.md`. Creating one
  puts the rule in front of every session in this repo. The rule should list the
  triggers: `package.json` `engines`, a new `process.env` read, a new path under
  `<cfg>/cc-dashboard/`, and changes under `mod/` or `bin/` that affect install.
  The transcript row store (`docs/ideas/data-storage.md`)
  is the first change that needs it: it adds `transcripts.db` and `TRANSCRIPTS_DB`
  and removes `records.json` and `RECORDS_FILE`.

- **SETUP.md or the README.** The README's "Run it", "Setting up the recorder" and
  "Without the mod" sections already hold most of the steps. Decide whether
  `SETUP.md` takes them over and the README links to it, or repeats them.
- **Linux and Windows.** The mod builds paths with `/` and `$HOME`. Decide whether to
  state macOS and Linux only, and give the Linux `RTK_DB` path.
- **An install route that survives a move.** A marketplace file in the repo would
  allow `/plugin install cc-dashboard --marketplace <owner>/<repo>`, but the mod would
  still need `bin/` beside it.
- **A check step.** A new user needs a way to see that each piece works: the server
  page, `claude plugin validate`, a session snapshot appearing in `sessions/`.
