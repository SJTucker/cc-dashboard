# Claude Code Dashboard

A small, local dashboard for your Claude Code usage, making one network request only
when you click Check prices: daily and cumulative cost, daily tokens broken out by
input / output / cache-write / cache-read, cost by model with dollars per million
tokens, and a weekday-by-hour heatmap of when the spend happens.

If you use `rtk`, it also charts the command output rtk filtered out before it reached
the model. See "rtk savings" below.

Built to be easy to fully read in one sitting — five small files, two dependencies,
no telemetry, no CDN. It makes one outbound request, and only when you click
Check prices.

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

While editing the code, run `npm run watch`. Node's `--watch` flag restarts
the server when `server.js` or any file under `lib/` changes. Files under
`public/` are read from disk on each request, so a page reload picks them up
without a restart. A restart clears the scan cache, so the first request after
it takes a full scan.

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
- **The recorder.** `bin/record-statusline` reads Claude Code's statusline JSON on
  stdin, which includes `rate_limits` after the first API response of a session.
  The dashboard's Claude Code mod runs it after each turn (see "Setting up the
  recorder" below). It writes the rate limits to
  `~/.claude/rate-limits.json`, or `$CLAUDE_CONFIG_DIR/rate-limits.json` when that
  is set. With the mod, its numbers change after each main turn, and when a
  rate-limit window moves 1 point. Without the mod, they change after every API
  response in any running session, as before.
  The same script also keeps one small snapshot per session, holding that
  session's cost and duration, in
  `~/.claude/cc-dashboard/sessions/` (or `$CLAUDE_CONFIG_DIR/cc-dashboard/sessions/`,
  or `LIVE_SESSIONS_DIR`). The Live sessions panel reads them. Snapshots older than
  a day are deleted on the next write. The panel's Session cost and Session length
  columns come from that snapshot, so they cover the whole session from whenever it
  started. Its Cost today, Tokens today and Lines columns come from today's
  transcripts instead, so a session that started yesterday shows more session cost
  than cost today. Lines counts the lines added and removed by Edit and Write
  calls, subagents included. Edits made through Bash, such as `sed -i`, are not
  counted. The two costs differ for a session that started today, too. Session
  cost is Claude Code's own counter. That counter includes calls that write no
  transcript line, such as session titles. So Session cost is usually the higher
  of the two. Cost today can be higher while subagents run. Subagent calls reach
  the transcripts right away. Session cost updates after the main session's next
  turn, or on the next statusline render without the mod.

### Setting up the recorder

The dashboard ships a Claude Code mod in `mod/`. Link it into your skills folder, and
every Claude Code session loads it:

```bash
ln -s ~/code/cc-dashboard/mod ~/.claude/skills/cc-dashboard
```

After each main turn, and whenever a rate-limit window moves by 1%, the mod runs
`bin/record-statusline`. When a session ends, it runs `bin/record-session-end`.
The mod needs nothing in your statusline script or in `settings.json`. It uses
Claude Code's function hooks, which are early access and may change between
releases. If an update breaks it, the transcript shows one line starting
`cc-dashboard:`, or the Plan usage panel's "as of" time stops moving.
`claude plugin validate ~/code/cc-dashboard/mod` says what the engine refuses.

### Claude Code updates

The mod also marks Claude Code releases that could change usage. At each session
start, after the session is ready, it checks whether the running version has a
verdict in `~/.claude/cc-dashboard/updates.json`. When it has none, the mod fetches
`CHANGELOG.md` from the `anthropics/claude-code` repository and asks Haiku, through
your Claude Code login, whether the entry could change tokens, caching, context,
compaction, tool output, subagents, or default model or effort. `bin/judge-updates`
writes the verdict. A relevant version gets a star marker at the first call made on
it.

Run `/backfill-updates` once to judge every version in your transcripts. It reports
how many versions it judged and how many are relevant.

Each version is judged once. To change a verdict, edit `relevant` or `summary` in
`updates.json`. To have a version judged again, delete its entry. Failures show as a
transcript line starting `cc-dashboard:`. The Haiku calls write no transcript line,
so the dashboard's totals leave out their cost.

### Without the mod

The scripts also work on their own. Use this path or the mod, not both.

Add one line to your existing statusline script (the command `statusLine.command` in
`~/.claude/settings.json` points at):

```bash
echo "$input" | ~/code/cc-dashboard/bin/record-statusline
```

`bin/record-limits` is the script's old name and still works.

`record-statusline` never writes to stdout or stderr and always exits 0, so adding it
does not change what the statusline shows. Do not point `statusLine.command`
straight at `record-statusline`. It prints nothing, so the statusline would be blank.
With no statusline script yet, a minimal one looks like this:

```bash
#!/bin/bash
input=$(cat)
echo "$input" | ~/code/cc-dashboard/bin/record-statusline
echo "$input" | jq -r '.model.display_name'
```

For the cleared and ended marks in Live sessions, also run `bin/record-session-end` as
a `SessionEnd` hook. Add this key to the `"hooks"` object in
`~/.claude/settings.json`. If the file has no `"hooks"` object, create one at the top
level, `"hooks": { … }`, and put the key inside it. Do not add a second `"hooks"`
key: JSON keeps only the last one, and the hooks in the other are silently dropped.

```json
"SessionEnd": [
  { "hooks": [{ "type": "command", "command": "~/code/cc-dashboard/bin/record-session-end" }] }
]
```

`record-session-end` never writes to stdout or stderr and always exits 0.

### What the panels show

When either window reaches 75%, a warning banner at the top of the page shows on
every range, with the percentage and the reset time.

The panel also shows today's share of the weekly limit: the weekly percent now minus
the weekly percent when the day started. `bin/record-statusline` keeps that
starting point in `rate-limits.json` as `dayStart`. A day starts at the last
reading before it, so the day's first API response counts toward that day. After
a weekly reset, the day counts from 0. If `rate-limits.json` has a reading from
earlier the same day but no `dayStart`, the day counts from that reading. The
"Today (share of the week)" row then says "counted from today's first reading",
because usage before that reading is not known. On a workday (Monday to Friday) the
share is compared with two budgets. The fixed budget is 20% of the week. The
rolling budget is the weekly percent left at the start of the day, divided by the
workdays left before the reset. The warning banner shows when today reaches 19%.
Weekends show the share with no budget. The budget and the workdays are constants in
`lib/limits.js`. Usage outside Claude Code, such as claude.ai, reaches the weekly
percent but produces no statusline reading. That usage is counted toward the day of
the next Claude Code API response.

Both sources are undocumented internal detail, so a Claude Code release may change
either shape. When a source is missing, unreadable, or in a shape the dashboard
does not expect, it is treated as absent, not an error; if both are absent, the
panel stays hidden. The panel's note names which source it used. Claude Code only
produces either source for claude.ai subscription logins, and only while it runs,
so the panel shows the time of the last update. Per-model weekly limits are left
out. Read the usage cache from another file with `CLAUDE_JSON=~/path/.claude.json
npm start`, or the statusline file with `RATE_LIMITS_JSON=~/path/rate-limits.json
npm start`. `PRICES_JSON=~/path/prices.json` moves the applied price history.

The Live sessions panel marks a session "cleared" after `/clear`, and "ended" after
any other end, such as quitting or `/resume`. It reads this from
`bin/record-session-end`, which the mod runs when a session ends. Without the mod,
the `SessionEnd` hook under "Without the mod" runs it. With neither, a session shows
as live for 10 minutes after its last response. So after a `/clear`, the old session
and the new one both show as live for up to 10 minutes. A resumed session keeps its
session id, so its row shows as live again after its next response.

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

Plugin installs, the first use of a new model, and Claude Code releases that could
change usage are marked automatically. The releases come from the mod (see "Claude
Code updates" below). Add anything else to `changes.json` in this folder. It is gitignored, and the dashboard
only reads it:

```json
[
  { "date": "2026-09-04T11:15", "kind": "rtk", "label": "rtk config.toml rewritten" },
  { "date": "2026-09-15T10:45", "kind": "claude-md", "label": "CLAUDE.md: don't commit docs" }
]
```

`date` is local time. Include the time: a bare date means midnight, which puts that
whole day in "after". `kind` is one of `plugin`, `skill`, `hook`, `claude-md`,
`rtk`, `config`, `effort`, `model`, `claude-code`, `other`, and picks the marker's shape. Keep the
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

- **Read-only, except for two write paths.** The dashboard server only ever reads
  your `~/.claude/projects` folder, the plugin list and `.claude.json` beside it,
  `changes.json`, and `rate-limits.json`, and opens rtk's `history.db` with
  sqlite's `readOnly` flag. One write path is `bin/record-statusline`, `bin/record-session-end` and `bin/judge-updates`, separate
  scripts the dashboard's Claude Code mod runs (see "Plan usage" above); they write only
  `rate-limits.json`, the per-session snapshots in `cc-dashboard/sessions/`, and, through `bin/judge-updates`, `cc-dashboard/updates.json`.
  The other is the Apply button in the Cost by model panel: clicking it is the
  only thing that writes `prices.json` (`PRICES_JSON` moves it), and nothing else
  under `server.js` or `public/` writes anything.
- **One network request from the server, on demand.** The Cost by model panel has a Check prices
  button. Clicking it makes the server fetch
  `https://platform.claude.com/docs/en/about-claude/pricing.md`, Anthropic's pricing
  page as markdown. Nothing fetches on page load, on a timer, or at startup. The URL
  is a constant in `lib/price-fetch.js`. The page's Content-Security-Policy blocks
  the browser from contacting any other host, so the request always comes from the
  server. The bar charts are hand-drawn SVG (see `public/app.js`), so no charting
  library comes from a CDN.
  
  Separately, the Claude Code mod fetches the Claude Code changelog from
  `raw.githubusercontent.com` and makes one Haiku call per 20 versions, only when the
  running Claude Code version has no verdict or when you run `/backfill-updates`.
  That request comes from Claude Code, not from the dashboard server.
- **Localhost only.** The server binds to `127.0.0.1` and rejects any request whose
  `Host` header isn't `localhost`/`127.0.0.1`, which blocks the DNS-rebinding trick
  where a malicious website re-points its own hostname at your machine (see
  `lib/net-guard.js` for the full explanation). There's no login, so don't change
  the bind address to something network-reachable unless you understand that
  trade-off.
- **Pricing is an estimate, with a dated history.** `lib/pricing.js` has a built-in
  price table, last checked against Anthropic's pricing page on 2026-09-28. Check
  prices lists new models and changed prices and changes nothing. Apply saves them
  to `~/.claude/cc-dashboard/prices.json` (set `PRICES_JSON` to move it) with an
  effective-from date. A changed price applies to usage from that date on, and older
  usage keeps the price it had. A new model is priced for all dates. A page that
  does not parse is refused with the reason, and prices stay as they are. Any model
  the table does not recognize is still counted in token totals but shown as
  "unpriced" rather than silently costed at $0.

## File layout

```
server.js              Express app: binds to localhost, serves /api/summary, /api/rtk, /api/changes, /api/limits, /api/records, /api/sessions/live and the price routes (/api/prices, /api/prices/check, /api/prices/apply)
lib/scan.js            Walks ~/.claude/projects, parses JSONL, aggregates by day and model
lib/rtk.js             Reads rtk's history.db read-only, aggregates by day and command
lib/efficiency.js      Session start, Bash result and per-prompt statistics per time window
lib/changes.js         Setup change markers: plugin installs, new models, changes.json
lib/limits.js          Plan usage limits from the .claude.json usage cache and the statusline rate-limits file
lib/pricing.js         Built-in price table, dated price versions, cost calculation
lib/price-store.js     Applied price history in prices.json
lib/price-fetch.js     Fetch and parse Anthropic's pricing page
lib/net-guard.js       Host-header check + security headers
lib/sessions.js        Per-session snapshots from the statusline, and today's live sessions
bin/record-statusline  Reads statusLine JSON from stdin, writes the rate-limits file and a session snapshot
bin/record-limits      Old name for bin/record-statusline, kept as a wrapper
bin/record-session-end Marks a session snapshot ended, from SessionEnd hook JSON on stdin
bin/judge-updates      Lists Claude Code versions to judge and records Haiku's verdicts in updates.json
mod/                   Claude Code mod that runs the recorders and judges new Claude Code releases
public/index.html      Page shell
public/style.css       All styling
public/app.js          Fetches /api/summary, /api/rtk, /api/limits, /api/sessions/live, /api/changes, /api/records and /api/prices, draws the SVG charts, has the Check prices / Apply controls, no dependencies
public/hud.js          Display helpers for the header status strip and the Plan usage Today meter
public/chart-geometry.js  X-axis label spacing and tooltip placement for the charts
public/fonts/          Oxanium, Saira Condensed and JetBrains Mono (SIL OFL), with their licence files
```

## Extending it

A few obvious next steps if you want to keep going, roughly in order of effort:
- **All-time session drill-down**: `lib/scan.js` already has everything needed
  per-file; add a route such as `/api/sessions/history` that returns per-session
  totals across all time, instead of only the daily/model rollups. `/api/sessions/live`
  already covers today's sessions, so a new route needs a different name.
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
- **A hook that appends to `changes.json`**: a Claude Code hook on edits to
  `~/.claude/settings.json`, `CLAUDE.md` or skills could add an entry, so the file
  keeps itself current. That write would belong to the hook, not the dashboard.
