# Setup

These steps take you from `git clone` to every panel showing data. The README says
what each panel shows.

## Requirements

- **macOS.** Linux and Windows are untested.
- **Node 22.13 or later.** The server stores usage history in SQLite through
  `node:sqlite`, which needs no flag from Node 22.13. The server does not start
  without it. The rtk panels use the same module.
- **`node` on the PATH that Claude Code sees.** The mod runs the scripts in `bin/`
  directly, through their `#!/usr/bin/env node` line. A clone keeps their exec bit.
- **Claude Code.** The mod uses Claude Code's function hooks, which are early access.
  No minimum version is known. The mod was last run on 2.1.294.

## Quick setup

From a fresh clone:

```bash
git clone <this repository's URL> cc-dashboard
cd cc-dashboard
bin/setup
npm start
```

Then open **http://localhost:3600**.

`bin/setup` checks for Node 22.13 or later, `npm` and `claude` on your PATH, and
stops before changing anything if one is missing. Then it runs `npm install`,
links `mod/` to `~/.claude/skills/cc-dashboard`, and runs `claude plugin validate`.
`bin/setup` reads `CLAUDE_CONFIG_DIR` from the shell that runs it, so set it there to
the same value Claude Code uses. It is safe to run again. When a file, folder or link
already sits at the link path, `bin/setup` stops, names the path and leaves it in
place.

`bin/setup` does not start the server or edit `settings.json`. The sections below
give the same steps by hand.

## Run the server

```bash
git clone <this repository's URL> cc-dashboard
cd cc-dashboard
npm install
npm start
```

Then open **http://localhost:3600**.

- The server binds `127.0.0.1` only.
- `node server.js --port 3601` or `PORT=3601 npm start` picks another port.
- `npm run dev` also opens the browser.
- `npm run watch` restarts the server when `server.js` or a file under `lib/`
  changes.

The first page load reads every transcript under `~/.claude/projects` and stores the
rows, and the session reviews, in `~/.claude/cc-dashboard/transcripts.db`. Later
loads, and later starts, read only the transcripts that changed. The server creates
`~/.claude/cc-dashboard/` if it is missing, so that folder must be writable.

## Install the mod

The mod in `mod/` records plan usage, live session state, session reviews, Claude Code
release markers and setup change markers, and writes a handoff 6 minutes before the
1-hour prompt cache expires or when Claude Code compacts an idle session. It also
shows a dismissable band above the prompt when the Session or Week plan window
reaches 75%. Link it into your skills folder from the clone:

```bash
ln -s "$PWD/mod" ~/.claude/skills/cc-dashboard
claude plugin validate "$PWD/mod"
```

`bin/setup` runs both lines.

Every Claude Code session started after that loads the mod. It needs no change to
your statusline script or to `settings.json`.

- **`mod/` must stay beside `bin/`.** The mod follows the link back to the clone and
  runs `<clone>/bin/<script>`. A copy of `mod/` on its own finds no scripts.
- **Moving the clone breaks the link.** Remove `~/.claude/skills/cc-dashboard` and run
  the `ln -s` line again from the new location. Running `bin/setup` again after
  removing the link also works.
- **A failure shows as one transcript line** starting `cc-dashboard:`.
  `claude plugin validate` says what Claude Code refuses to load.

Without the mod, the Plan usage panel reads only the usage cache in `~/.claude.json`,
which updates when you run `/usage`. Live sessions has no Length column data and no
cleared or ended marks.

## Cache countdown in the statusline

Optional. Replace `/path/to/cc-dashboard` below with the clone's path. `pwd` in
the clone prints it.

`bin/cache-line` prints one line about the session's prompt cache: how
long until it expires, and what the next reply pays to write the context back into it.

```
cache 4 min left · rebuild $0.38
cache under 1 min · rebuild $0.38
cache expired · rebuild $0.38
```

It reads the `prompt_cache` block Claude Code sends the statusline, which needs
Claude Code 2.1.251 or later. It prints nothing before the session's first reply.
It reads and writes no files and always exits 0.

Add two lines to the statusline script that `statusLine.command` in
`~/.claude/settings.json` points at, after the lines it already prints. They read
the statusline JSON from `$input`, so the script must save its stdin near the top
with `input=$(cat)`. Keep the `if` block at the end. Claude Code blanks the
whole statusline when the script's last command exits non-zero, and
`[ -n "$CACHE" ] && echo "$CACHE"` exits 1 when the cache line is empty.

```bash
CACHE=$(printf '%s' "$input" | /path/to/cc-dashboard/bin/cache-line)
if [ -n "$CACHE" ]; then
  echo "$CACHE"
fi
```

With no statusline script yet, this minimal one shows the model and the cache line.
Save it, make it executable with `chmod +x`, and point `statusLine.command` at it.

```bash
#!/bin/bash
input=$(cat)
printf '%s' "$input" | jq -r '.model.display_name'
CACHE=$(printf '%s' "$input" | /path/to/cc-dashboard/bin/cache-line)
if [ -n "$CACHE" ]; then
  echo "$CACHE"
fi
```

Claude Code reruns the statusline after each reply and when a warm cache expires,
but not while a session sits idle. To keep the minutes counting down, add
`refreshInterval`, in seconds, to `statusLine` in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "~/.claude/statusline.sh", "refreshInterval": 15 }
```

Each refresh runs the whole statusline script, so keep the script fast.

## rtk

The two rtk panels read rtk's `history.db` read-only. The default path is
`~/Library/Application Support/rtk/history.db`. Set `RTK_DB` for another location.
Without rtk the panels do not appear.

## Environment variables

`<cfg>` is `CLAUDE_CONFIG_DIR`, or `~/.claude` when it is unset. The server, the mod
and the `bin/` scripts write every file under `<cfg>`, so `CLAUDE_CONFIG_DIR` is the
only variable that moves them.

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `3600` | The server's port. `--port` takes precedence. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config folder, and so `<cfg>` for every path in "Files outside the repo". A leading `~` is expanded. |
| `RTK_DB` | `~/Library/Application Support/rtk/history.db` | rtk's history. A leading `~` is expanded. |

Set a variable for the server when you start it, for example
`CLAUDE_CONFIG_DIR=/path/to/.claude npm start`.

The mod and the `bin/` scripts run inside Claude Code, so they read
`CLAUDE_CONFIG_DIR` from Claude Code's environment. `bin/setup` is the exception. It
runs in your shell, so it reads `CLAUDE_CONFIG_DIR` from that shell. Set it there to
the same value Claude Code uses. If you set `CLAUDE_CONFIG_DIR`, give the server the
same value. Otherwise the server reads transcripts and snapshots from a folder Claude
Code does not write to. The mod also reads `HOME`, to find `~/.claude` when
`CLAUDE_CONFIG_DIR` is unset, to find rtk's config, and to expand a leading `~` in
paths. Without `HOME` the mod records no setup changes.

`CHANGES_FILE` also exists. It points the server at another `changes.json` so the
tests can avoid the one in the clone.

## Files outside the repo

| Path | Override | Written by |
|---|---|---|
| `<cfg>/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR` | Claude Code |
| `~/.claude.json`, or `<cfg>/.claude.json` when `CLAUDE_CONFIG_DIR` is set | `CLAUDE_CONFIG_DIR` | Claude Code |
| `<cfg>/plugins/installed_plugins.json` | `CLAUDE_CONFIG_DIR` | Claude Code |
| `<cfg>/plugins/store/cc-dashboard_<id>.json` | `CLAUDE_CONFIG_DIR` | Claude Code, for the mod's key-value store. It holds the update check, the setup snapshots, and a ready handoff's resume prompt per session until that session's next prompt or end. |
| `<cfg>/rate-limits.json` | `CLAUDE_CONFIG_DIR` | `bin/record-statusline`, run by the mod |
| `<cfg>/skills/cc-dashboard` (a symlink to the clone's `mod/`) | `CLAUDE_CONFIG_DIR` | `bin/setup`, or you with `ln -s` |
| `<cfg>/cc-dashboard/sessions/` | `CLAUDE_CONFIG_DIR` | `bin/record-statusline` and `bin/record-session-end`, both run by the mod. `bin/record-statusline` deletes snapshots older than a day. Each snapshot also holds a launch id, shared by every session one `claude` process recorded. |
| `<cfg>/cc-dashboard/activity/` | `CLAUDE_CONFIG_DIR` | the mod. The server deletes files older than a day when the page shows the Today range. |
| `<cfg>/cc-dashboard/changes/` | `CLAUDE_CONFIG_DIR` | the mod |
| `<cfg>/cc-dashboard/setup/` | `CLAUDE_CONFIG_DIR` | the mod |
| `<cfg>/cc-dashboard/updates.json` | `CLAUDE_CONFIG_DIR` | `bin/judge-updates` |
| `<cfg>/cc-dashboard/limit-warnings.json` | `CLAUDE_CONFIG_DIR` | the mod. Holds the level (75 or 90) each plan window's band was last dismissed at, shared by every running session. |
| `<cfg>/cc-dashboard/transcripts.db` | `CLAUDE_CONFIG_DIR` | the server, `bin/review-session` |
| `<cfg>/cc-dashboard/prices.json` | `CLAUDE_CONFIG_DIR` | the server, when you click Apply |
| `<worktree root>/.claude/handoffs/` of each session's project, or the session's folder outside git | none | the mod, 6 minutes before a 1-hour prompt cache expires or when Claude Code's idle compaction starts, whichever comes first. Each file summarises a whole conversation, so add `.claude/handoffs/` to that repo's `.gitignore`. |
| rtk's `history.db` | `RTK_DB` | rtk |

`transcripts.db` runs in SQLite WAL mode. While a process has it open,
`transcripts.db-wal` and `transcripts.db-shm` sit beside it. Back up all three
together, or none while a process is running.

Review files that earlier versions wrote to `<cfg>/cc-dashboard/reviews/` are copied
into `transcripts.db` once. The import runs the first time the server answers a
reviews request (the first `/api/reviews` or dismiss request, through `getReviewDb`)
or the first time `bin/review-session` runs. The server does not import when it
first opens the file. The folder stays on disk and is never read or written again.

The mod also reads these files to record setup changes. It writes none of them.

- `<cfg>/CLAUDE.md`, the files it includes with an `@path` line, and `<cfg>/rules/`
- `<cfg>/settings.json` and `<cfg>/settings.local.json`
- `<cfg>/skills/*/SKILL.md` and `<cfg>/agents/*.md`
- the scripts named by hook commands and by `statusLine` in `settings.json`
- `config.toml` and `filters.toml` in `~/Library/Application Support/rtk/`. This path
  ignores `RTK_DB`.
- each session's project `CLAUDE.md`, `CLAUDE.local.md` and `.claude/settings.json`

`bin/review-session` reads these files for each session it reviews. It writes none
of them.

- `<cfg>/CLAUDE.md` and the files it includes with an `@path` line
- `CLAUDE.md` and `CLAUDE.local.md` in the session's start folder and in each
  folder above it. The start folder is the `cwd` on the first transcript line that
  has one.
- `<cfg>/projects/<folder>/memory/MEMORY.md`, where `<folder>` names the main
  checkout of the session's git repo. Outside a repo, or when that file is missing,
  it is the one next to the session's transcript. Finding the main checkout reads
  the `.git` file of a worktree and the `commondir` file it points to.

## Network and model use

- **The server** makes one request, and only when you click Check prices. It fetches
  Anthropic's pricing page from `platform.claude.com`.
- **The mod** fetches `CHANGELOG.md` from `raw.githubusercontent.com/anthropics/claude-code`
  when the running Claude Code version has no verdict, or when you run
  `/backfill-updates`.
- **The mod calls Haiku** through your Claude Code login to judge releases, review
  ended sessions and label setup changes. No API key is read. These calls write no
  transcript line, so the dashboard's totals leave out their cost. Reviews and labels
  run in interactive sessions only. Each call sends this:
  - **Judging releases:** the changelog entries of up to 20 versions. Nothing from
    your setup or transcripts is sent.
  - **Reviewing a session:** the rule files listed under "Files outside the repo", cut
    to 30,000 characters, and a digest of its transcript. The digest holds the first
    400 characters of each typed prompt and the first 200 characters of each Claude
    reply. The digest names each tool call with its file path, URL host, skill,
    subagent type or Bash program name. Bash arguments are not sent. The digest also
    holds the first 200 characters of each tool error. A digest over 60,000 characters
    keeps its first 20,000 and last 40,000.
  - **Labelling a setup change:** the file's short name and its added and removed
    lines, up to 4,096 characters. Labelling covers `CLAUDE.md`, the files it includes
    with `@path`, rules, skills, agents, and a project's `CLAUDE.md` and
    `CLAUDE.local.md`. Changes to settings files, hook scripts, the statusline script
    and rtk's config are labelled on your machine and not sent.
- **The mod forks the session's own model** once per idle gap, to write a handoff
  document. It does this 6 minutes before the prompt cache expires, in a session with
  a 1-hour cache and at least 50,000 tokens of context. It also does it when Claude
  Code compacts an idle session, which happens after about 54 idle minutes in a
  1-hour session with at least 200,000 tokens. Whichever comes first writes the
  handoff. The fork reads the whole conversation from the prompt cache and sends the
  output of `git rev-parse`, `git branch`, `git log`, `git worktree list`,
  `git status`, `git diff --stat` and `git stash list` for the session's folder, and
  the current date. It writes no transcript line, so the dashboard's totals leave out
  its cost. To find the cache's lifetime and expiry, the mod runs `bin/cache-state`
  after each turn, which reads the session's transcript. Turning off idle compaction
  (`"idleCompaction": false`, `"autoCompactEnabled": false`, `DISABLE_AUTO_COMPACT=1`
  or `DISABLE_COMPACT=1`) does not turn off the handoff.

## Check it works

1. **The server.** `npm start` prints `Claude Code Dashboard running at
   http://localhost:3600`. The page loads at that address.
2. **The database.** After the first page load, the server's output has no `[store]`
   warning and `~/.claude/cc-dashboard/transcripts.db` exists.
3. **The mod.** `claude plugin validate "$PWD/mod"` passes, run from the clone.
   `bin/setup` runs this check.
4. **The recorder.** Start a Claude Code session and send one prompt. A file named
   after the session id appears in `~/.claude/cc-dashboard/sessions/`, and the Plan
   usage panel's "as of" time is a moment ago.
5. **Live state.** While that session runs, its row in Running now shows ▶ working or
   ⏸ waiting on you in the State column.
