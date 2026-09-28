# My Claude Code Dashboard

A small, local, offline dashboard for your Claude Code usage: daily and cumulative cost,
daily tokens broken out by input / output / cache-write / cache-read, cost by model with
dollars per million tokens, and a weekday-by-hour heatmap of when the spend happens.

If you use `rtk`, it also charts the command output rtk filtered out before it reached
the model. See "rtk savings" below.

Built to be easy to fully read in one sitting — five small files, two dependencies,
no telemetry, no CDN, no outbound network calls of its own.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3600**.

Options:
```bash
node server.js --port 3601      # use a different port
node server.js --open           # also open your browser automatically
```

By default it reads `~/.claude/projects`. If you use a custom Claude config
location, set `CLAUDE_CONFIG_DIR` before starting it, same as Claude Code itself:

```bash
CLAUDE_CONFIG_DIR=/path/to/.claude npm start
```

## rtk savings (optional)

If you use `rtk` to filter command output before it reaches Claude, two extra panels
appear: how much output it stripped per day, and which commands it stripped the most
from.

These are read straight from rtk's own sqlite history, opened read-only. Nothing
invokes the `rtk` binary, because every `rtk` call writes a row and would inflate the
numbers being displayed.

The default location is macOS's `~/Library/Application Support/rtk/history.db`.
Elsewhere, point at it yourself:

```bash
RTK_DB=~/.local/share/rtk/history.db npm start
```

No rtk, or a Node older than 22 (which is where the built-in `node:sqlite` arrived)?
The panels simply do not appear. Nothing else changes.

**These numbers are not billed tokens.** They are rtk's own estimate of output it
filtered out before the model saw it. The cost and token figures everywhere else on
the page come from Claude Code's transcripts and count what Anthropic billed. Do not
add one to the other.

## Plan usage

On the Today range, a panel shows the two limits from Claude Code's `/usage` screen:
the current session (the 5-hour window) and the current week across all models.
The dashboard reads two possible sources and shows whichever was updated more
recently. It makes no network request of its own.

- **The usage cache.** Claude Code keeps its last `/usage` fetch in
  `~/.claude.json`, or in `$CLAUDE_CONFIG_DIR/.claude.json` when that is set.
  This file only updates when someone runs `/usage`, so between sessions it goes
  stale.
- **The statusline.** Claude Code's `statusLine` command receives a JSON object on
  stdin, which includes `rate_limits` after the first API response of a session.
  `bin/record-limits` reads that JSON from stdin and writes the rate limits to
  `~/.claude/rate-limits.json`, or `$CLAUDE_CONFIG_DIR/rate-limits.json` when that
  is set. Its numbers change after every API response in any running session.

To feed the statusline source, add one line to your existing statusline script
(the command `statusLine.command` in `~/.claude/settings.json` points at):

```bash
echo "$input" | ~/code/cc-dashboard/bin/record-limits
```

`record-limits` never writes to stdout or stderr and always exits 0, so adding it
does not change what the statusline shows. Do not point `statusLine.command`
straight at `record-limits`. It prints nothing, so the statusline would be blank.
With no statusline script yet, a minimal one looks like this:

```bash
#!/bin/bash
input=$(cat)
echo "$input" | ~/code/cc-dashboard/bin/record-limits
echo "$input" | jq -r '.model.display_name'
```

When either window reaches 75%, a warning banner at the top of the page shows on
every range, with the percentage and the reset time.

Both sources are undocumented internal detail, so a Claude Code release may change
either shape. When a source is missing, unreadable, or in a shape the dashboard
does not expect, it is treated as absent, not an error; if both are absent, the
panel stays hidden. The panel's note names which source it used. Claude Code only
produces either source for claude.ai subscription logins, and only while it runs,
so the panel shows the time of the last update. Per-model weekly limits are left
out. Read the usage cache from another file with `CLAUDE_JSON=~/path/.claude.json
npm start`, or the statusline file with `RATE_LIMITS_JSON=~/path/rate-limits.json
npm start`.

## Setup changes

Two panels at the bottom show whether a change to your setup moved the numbers. Both
cover all history, whatever range is picked.

- **Context at session start**: the tokens in each session's first call (system
  prompt, tool definitions, CLAUDE.md, skill list, hook output), with your changes
  marked under the time axis. The task barely affects this number, so a step up or
  down points to a setup change or a Claude Code release.
- **Before and after**: pick a change to compare the 7 days before it with the 7
  days after. The chart shows the median Bash result size on the main thread per
  day, which is what rtk acts on.

Plugin installs and the first use of a new model are marked automatically. Add
anything else to `changes.json` in this folder. It is gitignored, and the dashboard
only reads it:

```json
[
  { "date": "2026-09-04T11:15", "kind": "rtk", "label": "rtk config.toml rewritten" },
  { "date": "2026-09-15T10:45", "kind": "claude-md", "label": "CLAUDE.md: don't commit docs" }
]
```

`date` is local time. Include the time: a bare date means midnight, which puts that
whole day in "after". `kind` is one of `plugin`, `skill`, `hook`, `claude-md`,
`rtk`, `config`, `effort`, `model`, `other`, and picks the marker's shape. Keep the
file somewhere else with `CHANGES_FILE=~/path/changes.json npm start`.

A before/after is only as clean as its window. When another change falls within 7
days either side, the panel lists it, and the numbers cover both.

Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default), so
history has a sliding start rather than a fixed one. A before/after needs history on
both sides of a change, so a change less than 7 days newer than your oldest surviving
transcript has no "before" window to compare and gets no marker. Raising
`cleanupPeriodDays` in `~/.claude/settings.json` keeps more history and pushes that
boundary back.

## What it does and doesn't do

- **Read-only, except for one script.** The dashboard server only ever reads your
  `~/.claude/projects` folder, the plugin list and `.claude.json` beside it,
  `changes.json`, and `rate-limits.json`, and opens rtk's `history.db` with
  sqlite's `readOnly` flag. The one write path in this project is
  `bin/record-limits`, a separate script your own statusline pipes into (see
  "Plan usage" above); it writes only `rate-limits.json`, and nothing under
  `server.js` or `public/` calls it.
- **No network calls.** Unlike some similar tools, this one does not fetch pricing
  from the internet, load a charting library from a CDN, or phone home in any way.
  The bar charts are hand-drawn SVG (see `public/app.js`). Pricing is a small
  hardcoded table in `lib/pricing.js`. The only thing that could make this reach the
  network is `npm install` itself, to fetch its two dependencies.
- **Localhost only.** The server binds to `127.0.0.1` and rejects any request whose
  `Host` header isn't `localhost`/`127.0.0.1`, which blocks the DNS-rebinding trick
  where a malicious website re-points its own hostname at your machine (see
  `lib/net-guard.js` for the full explanation). There's no login, so don't change
  the bind address to something network-reachable unless you understand that
  trade-off.
- **Pricing is an estimate.** `lib/pricing.js` has a hardcoded price-per-token table
  for Opus/Sonnet/Haiku/Fable/Mythos. Anthropic's pricing can change — check
  <https://claude.com/pricing> and edit the numbers at the top of that file if they
  drift. Any model it doesn't recognize is still counted in token totals but shown
  as "unpriced" rather than silently costed at $0.

## File layout

```
server.js          Express app: binds to localhost, serves /api/summary, /api/rtk, /api/changes, /api/limits and /api/records
lib/scan.js         Walks ~/.claude/projects, parses JSONL, aggregates by day and model
lib/rtk.js          Reads rtk's history.db read-only, aggregates by day and command
lib/efficiency.js   Session start, Bash result and per-prompt statistics per time window
lib/changes.js      Setup change markers: plugin installs, new models, changes.json
lib/limits.js       Plan usage limits from the .claude.json usage cache and the statusline rate-limits file
lib/pricing.js       Offline per-token price table + cost calculation
lib/net-guard.js    Host-header check + security headers
bin/record-limits   Reads statusLine JSON from stdin, writes it to the rate-limits file via lib/limits.js
public/index.html   Page shell
public/style.css    All styling
public/app.js        Fetches /api/summary, /api/rtk, /api/limits, /api/changes and /api/records, draws the SVG charts, no dependencies
```

## Extending it

A few obvious next steps if you want to keep going, roughly in order of effort:
- **Session drill-down**: `lib/scan.js` already has everything needed per-file; add
  an `/api/sessions` route that returns per-session totals instead of only the
  daily/model rollups.
- **Per-project breakdown**: project folder names under `~/.claude/projects` are
  the encoded path (e.g. `-Users-you-code-myapp`) — decode and group by them.
  Skipped in this offline version to keep the pricing table's approach honest: it's
  an estimate, and cost figures for pieces smaller than the machine-wide daily total
  didn't feel worth the extra code.
- **5-hour billing-window blocks**: mirror what `/usage` shows, by bucketing
  messages into rolling 5-hour windows instead of calendar days.
- **A `--live` mode**: rerun the scan on an interval and push updates over SSE
  instead of requiring a manual refresh.
- **Same-week model comparison**: when two models run in the same week, compare them
  side by side (cost per prompt, calls per prompt, output and thinking tokens per
  call). Inside one week the calendar and the setup are the same for both, which
  comparing this month with last month cannot give you. The efficiency records from
  `lib/scan.js` already carry the model per call.
- **Tool error rate by model**: `lib/scan.js` already joins tool_use to tool_result
  errors. Split that by the model that made the call, and by cause. Without the cause
  split the rate misleads: here Opus 5.5 looked twice as error-prone as Opus 5, but 64
  of its 135 errors were the worktree isolation check blocking commands, which says
  where it was run, not how well it used the tools.
- **Cost per unit of work**: weekly spend divided by commits (from `git log` in each
  session's `cwd`, counted once per repository because worktrees share history) or by
  Edit/Write calls. It trends, but day-to-day values swing by a coefficient of
  variation near 0.7, so label it as noisy.
- **Claude Code version markers**: every line carries `version`. Left off the marker
  row because 23 versions shipped in one month here, several on the same day.
- **A hook that appends to `changes.json`**: a Claude Code hook on edits to
  `~/.claude/settings.json`, `CLAUDE.md` or skills could add an entry, so the file
  keeps itself current. That write would belong to the hook, not the dashboard.
