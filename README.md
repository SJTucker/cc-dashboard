# Claude Code Dashboard

A local dashboard for your Claude Code usage: daily and cumulative cost, daily tokens
broken out by input / output / cache-write / cache-read, cost by model with dollars
per million tokens, and a weekday-by-hour heatmap of when the spend happens.

If you use `rtk`, it also charts the command output rtk filtered out before it reached
the model. See "rtk savings" below.

Two dependencies, no telemetry, no CDN. The server makes one outbound request, and
only when you click Check prices. The optional Claude Code mod in `mod/` also fetches
Claude Code's changelog and calls Haiku through your Claude Code login. See "What it
does and doesn't do" below.

## Run it

[SETUP.md](SETUP.md) has the requirements, the install steps for the server and the
mod, every environment variable, and every file the dashboard reads or writes outside
this folder. In short, on Node 22.13 or later:

```bash
npm install
npm start
```

Then open **http://localhost:3600**.

While editing the code, run `npm run watch`. Node's `--watch` flag restarts
the server when `server.js` or any file under `lib/` changes. Files under
`public/` are read from disk on each request, so a page reload picks them up
without a restart. A restart keeps the stored rows in `cc-dashboard/transcripts.db`, so
the first request after it reads the transcripts modified today and any that changed
since the server stopped. When no database is available (see the Setup changes
section), nothing is stored and the first request reads every transcript.

## rtk savings (optional)

If you use `rtk` to filter command output before it reaches Claude, two extra panels
appear: how much output it stripped per day, and which commands it stripped the most
from.

These are read straight from rtk's own sqlite history, opened read-only. Nothing
invokes the `rtk` binary, because every `rtk` call writes a row and would inflate the
numbers being displayed.

The default location is `~/Library/Application Support/rtk/history.db`. `RTK_DB`
points at another one (see SETUP.md).

No rtk? The panels do not appear.

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
  `~/.claude/cc-dashboard/sessions/` (or `$CLAUDE_CONFIG_DIR/cc-dashboard/sessions/`).
  The Live sessions panel reads them. Snapshots older than a day are deleted on the
  next write. The panel's Length column comes from that
  snapshot, so it covers the whole session from whenever it started. Its Prompts,
  Cost today and Lines columns come from today's transcripts instead. A session that
  started yesterday shows fewer prompts, less cost and fewer lines than over its
  whole life. Lines counts the lines added and removed by Edit and Write calls,
  subagents included. Edits made through Bash, such as `sed -i`, are not counted.
  Hover a Cost today value to see the snapshot's own counter, "Session total since
  it started". That counter is Claude Code's own and includes calls that write no
  transcript line, such as session titles. So it is usually the higher of the two.
  Cost today can be higher while subagents run. Subagent calls reach the
  transcripts right away. The counter updates after the main session's next turn,
  or on the next statusline render without the mod.

### Setting up the recorder

The dashboard ships a Claude Code mod in `mod/`. SETUP.md has the steps to link it
into your skills folder. Every Claude Code session started after that loads it.

After each main turn, and whenever a rate-limit window moves by 1%, the mod runs
`bin/record-statusline`. When a session ends, it runs `bin/record-session-end`. It
writes each session's live state itself (see "Live state").
The mod needs nothing in your statusline script or in `settings.json`. It uses
Claude Code's function hooks, which are early access and may change between
releases. If an update breaks it, the transcript shows one line starting
`cc-dashboard:`, or the Plan usage panel's "as of" time stops moving.
`claude plugin validate mod`, run from this folder, says what the engine refuses.

### Claude Code updates

The mod also marks Claude Code releases that could change usage. At each session
start, after the session is ready, it checks whether the running version has a
verdict in `~/.claude/cc-dashboard/updates.json`. When it has none, the mod fetches
`CHANGELOG.md` from the `anthropics/claude-code` repository and asks Haiku, through
your Claude Code login, whether the entry could change tokens, caching, context,
compaction, tool output, subagents, or default model or effort. `bin/judge-updates`
writes the verdict. A relevant version gets a star marker at the first call made on
it.

A running version whose changelog entry is not out yet, as on release day, is
retried at most once an hour from session start. `/backfill-updates` judges it
whenever you run it.

Run `/backfill-updates` to judge every version in your transcripts. It reports how
many versions it judged and how many are relevant. Run it again whenever a version
missed its check: session start judges only the running version, so an update you
moved past before a later session waits for the next `/backfill-updates`.

Each version is judged once. To change a verdict, edit `relevant` or `summary` in
`updates.json`. To show a marker for a version Haiku rejected, set `relevant` to
true. The `summary` is optional and becomes the marker's label text. To have a
version judged again, delete its entry. Failures show as a transcript line starting
`cc-dashboard:`. The Haiku calls write no transcript line, so the dashboard's totals
leave out their cost.

### Setup changes recorded automatically

At each interactive session start the mod compares your setup files with the copies
it stored at the last check, and records a marker for each change. The mod watches:

- `~/.claude/CLAUDE.md`, the files it pulls in with an `@path` line, and
  `~/.claude/rules/`
- `~/.claude/settings.json` and `settings.local.json`
- `~/.claude/skills/*/SKILL.md` and `~/.claude/agents/*.md`
- the scripts named by hook commands and by `statusLine` in `settings.json`. A
  command is watched only when its first word is a path to a script (with `~` or
  `$HOME` expanded). A command such as `node ~/x.js` or `rtk hook claude` names no
  watched file.
- rtk's `config.toml` and `filters.toml` in `~/Library/Application Support/rtk/`
- the session's project: `CLAUDE.md`, `CLAUDE.local.md` and `.claude/settings.json`

A marker is dated to the file's modification time, so an edit found sessions later
still lands on the day it was made. An added file is dated no earlier than the
previous check of its folder, so a skill linked or copied in with an old modification
time does not land on an old day. Changes to one file of one kind on the same day
become one marker. A settings change is split by key: `hooks` is a hook marker,
`effortLevel` an effort marker, `model` a model marker, and anything else a config
marker. `enabledPlugins` is left out, because plugin installs are marked already.

Haiku labels a change to `CLAUDE.md` and the files it pulls in with `@`, a rule, a
skill, an agent, or the project's `CLAUDE.md` or `CLAUDE.local.md` from the added and
removed lines. When Haiku fails, the label is the first added line. A settings label
lists the changed keys, for example `effortLevel high → medium`.

The first check stores copies and records nothing. A project's files are stored the
first time a session runs there, so its existing `CLAUDE.md` does not show as added.

Each session writes its markers to `~/.claude/cc-dashboard/changes/<session id>.json`.
To fix a label, edit it there. To drop a marker, delete its entry. The stored copies
are in `~/.claude/cc-dashboard/setup/`.

### Session reviews

When a session ends or `/clear` runs, the mod asks Haiku to review it and suggest up
to three changes. The kinds are a CLAUDE.md rule that would have prevented a
correction, a skill or hook for repeated steps, token waste such as large tool output
or repeated reads, and a change to how the session was run. "No suggestions" is a
normal result. The Session reviews panel lists the reviews from the last 7 days. Each
review shows the session's title (Claude Code's last `ai-title` line, when the
transcript has one), the project and the git branch the session ended on, and the
path of the transcript file. The Copy prompt button copies a prompt that names the
transcript and lists Haiku's suggestions, so you can paste it into a stronger model
to check them. A review made before the transcript path was saved shows the path
found by session id, and no title. A review made before branches were saved shows no
branch.

Each open suggestion has Done and Not useful buttons. A dismissed suggestion is
hidden, and the review shows `N dismissed · Show`. Show lists each dismissed
suggestion with `Marked done` or `Marked not useful` and an Undo button. Copy prompt
leaves dismissed suggestions out. The panel note counts reviews that still have an
open suggestion. A review whose suggestions are all dismissed shows as one line that
opens with Enter or Space.

- **When it runs.** After a `/clear` or an in-process `/resume`, at once, because the
  process goes on. After an exit, at the next session start in any project. `-p` and
  Agent SDK runs do not start reviews.
- **What is reviewed.** Sessions with an `endedAt` in their snapshot and 3 or more
  typed prompts. Each review pass, at a session start or a `/clear`, reviews at most 3 sessions.
- **What Haiku sees.** A digest of the transcript, one line per typed prompt, reply
  start, tool call, tool error, large tool result and compaction. Prompts are cut to
  400 characters and the digest to about 60,000 characters.
- **Where results go.** The `reviews` and `suggestions` tables in
  `~/.claude/cc-dashboard/transcripts.db`, written by `bin/review-session`. Rows are
  never deleted. The panel lists reviews finished in the last 7 days. Review files
  that earlier versions saved in `cc-dashboard/reviews/` are copied in once, and the
  folder is then left alone.
- **When the database cannot be opened.** The panel shows the reason as text.
  `bin/review-session` prints one line on stderr and exits 1, and the mod logs it.
- **Failures.** A failed review is retried after an hour while the session's
  snapshot is still there, which is 24 hours.
- **Cost.** Haiku calls made by the mod write no transcript line, so the dashboard's
  totals leave out their cost.

### Live state

The mod also records what each session is doing, so the Running now table can show
it. It listens to the main loop's events and keeps one small state per session:

- **working** from the start of a turn (`turn.start`).
- **waiting on you** from the end of a turn (`turn.complete`), whatever the reason.
- **The running tool**, set on `tool.call` and cleared when the tool returns. For
  Bash the text is the first 60 characters of the command, for Read, Edit and
  Write it is the file's name, and for any other tool the tool's name alone.
- **Subagents**, the number of the session's agents whose turn has not ended:
  pending, running and waiting agents in `$.agent.list()`, minus any whose
  `turn.complete` has fired. The count is taken at each write, and `agent.spawn`
  rewrites the file.

No state marks a permission prompt. The mod's one signal would be a `tool.check`
that answers `ask`, but that answer comes before the permission mode settles the
call, and a mod cannot read the mode. In auto mode the classifier settles the ask
without a dialog, so the session would show a prompt that never opened. A session
held at a permission prompt shows working, and after 10 minutes without updates, no
state. A session whose subagent waits on a permission prompt also shows working.
After 10 minutes without updates it shows no state, or waiting on you when the main
loop's turn has already ended.

The mod writes the state to `~/.claude/cc-dashboard/activity/<session id>.json`
(or under `$CLAUDE_CONFIG_DIR`) with `$.fs.write`, at most every 250 ms per
session. It writes the files itself, one write chain per session, so a session's
states land in order. `readActivity` in `lib/activity.js` reads the files and
deletes the ones older than a day. `session.end` stops the mod's writes for that
session, and the dashboard shows no state for a session it marks ended.
`resolveActivity` drops a working state whose file has not changed for 10 minutes,
because a crash sends no event. "Waiting on you" does not expire. Waiting while
subagents still run is shown as working. Each subagent tool call rewrites the file,
so a running subagent keeps it fresh. A killed subagent can leave its count in the
file, so after 10 minutes without updates that state is shown as waiting on you with
no subagents. Without the mod, no file exists and the State and Doing now columns
show "—". Subagent tool calls do not change the state of the main loop. A Bash
command's first 60 characters are stored in the activity file and shown on the page,
so the text can contain what you typed in that command.

### Without the mod

The scripts in `bin/` also run from your own statusline script and a `SessionEnd`
hook. SETUP.md has the steps and lists what that route leaves out. Use that route or
the mod, not both.

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
out.

The Live sessions panel holds two tables. Running now lists the live sessions,
meaning those that wrote to a transcript in the last 10 minutes, and any session
waiting on you, however long ago it last wrote. Its columns are Session, State, Doing
now, Cost today and Last active. The Session column shows the session's title, with
its project and git branch on a line under it. The title is Claude Code's last
`ai-title` line. A session without one shows the first prompt typed in it, in dimmer
italic type. Hover the branch for its full name and, when the session switched
branch, every branch it used. Prompts, Length and Lines are only in Today. Running
now is ordered by the start of each session's first span today (`runningSessions` in
`public/session-groups.js`), so rows do not move while they run. State shows ▶
working or ⏸ waiting on you. Doing now shows the running tool, such as `Bash: npm
test`, and the subagent count. Both show "—" without the mod (see "Live state").
Today lists every session of the day, live ones included, sorted by Cost today with
the highest first. Ended sessions of one project collapse into a single expandable
row when the project has two or more of them. The bar behind each Cost today value in
Today is that session's share of the day's highest single-session Cost today. Prompts
counts the prompts typed in the session today. The Total row sums Prompts, Lines and
Cost today.

The Live sessions panel marks a session "cleared" after `/clear`, and "ended" after
any other end, such as quitting or `/resume`. It reads this from
`bin/record-session-end`, which the mod runs when a session ends. Without the mod,
the `SessionEnd` hook from SETUP.md's "Without the mod" runs it. With neither, a
session shows as live for 10 minutes after its last response. So after a `/clear`, the
old session and the new one both show as live for up to 10 minutes. A resumed session keeps its
session id, so its row shows as live again after its next response.
When a project has two or more cleared or ended sessions, the panel shows them as
one row with the summed figures and a count of each state. Click the row's arrow to
list the sessions one by one. Live and idle open sessions always keep their own rows.

The Session timeline panel, above Live sessions, shows the same sessions by time on
the Today range. Each session has one lane, ordered by when it started working today.
A bar covers a stretch of activity: it is built from the times of the session's calls
today, subagent calls included, and a gap of more than 10 minutes starts a new bar.
The axis runs from the hour of the earliest call to the next whole hour after now,
and a dashed line marks now. A live session has solid bars, and its last bar ends in
an arrowhead at now if its last call was within the last 10 minutes. Every other
session has striped bars. Hover a bar for the session's title, project and branch,
the bar's time range, cost today and prompt count. The panel hides when no session
has a call today.

### Hiding panels

Each panel and summary card has an "x" button, shown when the pointer is over it or
it has keyboard focus. The button hides the panel or card. The ☰ button at the top
right lists everything hidden, and choosing an entry shows it again. The list is
kept in the browser's localStorage under `cc-dashboard:hidden`, so it is per
browser. Reset layout restores the panel order only and leaves hidden panels hidden.

A hidden panel is not drawn. A request is skipped when every panel and card it feeds
is hidden:

- `/api/changes`: both Setup changes panels
- `/api/rtk`: both rtk panels
- `/api/sessions/live`: Live sessions and Session timeline
- `/api/reviews`: Session reviews
- `/api/records`: the Record day card, plus on Today the Total cost and Total tokens cards
- `/api/prices`: Cost by model

`/api/summary` and `/api/limits` are always requested.

The Record day card's all-time value is the busiest day in the All range. It is
computed from the stored rows on each request, so no separate cache file exists.

## Setup changes

Two panels at the bottom show whether a change to your setup moved the numbers. Both
follow the range picker. Today and 7d show the last 14 days, 30d and 90d their own
span, and All shows everything. A stack of more than 5 change glyphs shows 5 and a
`+n` for the rest. Hover or focus the `+n` to list them. The before/after table
always uses the full 7-day windows, so its numbers do not change with the range.

- **Context at session start**: the tokens in each session's first call (system
  prompt, tool definitions, CLAUDE.md, skill list, hook output), with your changes
  marked under the time axis. The task barely affects this number, so a step up or
  down points to a setup change or a Claude Code release.
- **Before and after**: pick a change to compare the 7 days before it with the 7
  days after. Click a row of the table, or tab to it and press Enter, to chart that
  row's value per day beside the table. The panel opens on Session start context. Each
  day's value is computed the same way as the 7-day value in the table. The rtk rows
  show only the days the transcripts cover.

Plugin installs, the first use of a new model, Claude Code releases that could
change usage, and edits to your setup files are marked automatically. The releases
and the setup edits come from the mod (see "Claude Code updates" and "Setup changes
recorded automatically" above). Add anything else to `changes.json` in this folder.
It is gitignored, and the dashboard only reads it:

```json
[
  { "date": "2026-09-04T11:15", "kind": "rtk", "label": "rtk config.toml rewritten" },
  { "date": "2026-09-15T10:45", "kind": "claude-md", "label": "CLAUDE.md: don't commit docs" }
]
```

`date` is local time. Include the time: a bare date means midnight, which puts
that whole day in "after". `kind` is one of `plugin`, `skill`, `hook`,
`claude-md`, `rtk`, `config`, `effort`, `model`, `claude-code`, `other`, and picks
the marker's shape. Keep the file somewhere else with
`CHANGES_FILE=~/path/changes.json npm start`.

A before/after is only as clean as its window. When another change falls within 7
days either side, the panel lists it, and the numbers cover both.

Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default). The
dashboard stores the usage rows of each transcript last modified before today's local
midnight in `~/.claude/cc-dashboard/transcripts.db`. The All range, the Record day
card and these before/after windows keep the history of every transcript the
dashboard stored before Claude Code deleted it. A transcript deleted on the day it was
written is never stored. History starts at the first stored transcript. A
before/after needs history on both sides of a change, so a change less than 7 days
newer than your oldest stored row has no "before" window to compare and gets no
marker. `node:sqlite` needs Node 22.13 or later. When `transcripts.db` cannot be
opened or was written by a newer version of the dashboard, `openStore` in
`lib/store.js` leaves the file untouched, logs one warning and keeps rows in memory
only. History then starts at the oldest transcript on disk. Raising
`cleanupPeriodDays` in `~/.claude/settings.json` keeps more transcripts on disk.

## What it does and doesn't do

- **Read-only, except for four write paths.** The dashboard server only ever reads
  your `~/.claude/projects` folder, the plugin list and `.claude.json` beside it,
  `changes.json`, the setup change markers in `cc-dashboard/changes/`,
  `rate-limits.json` and the activity files in `cc-dashboard/activity/`, and opens rtk's `history.db` with
  sqlite's `readOnly` flag. One write path is `bin/record-statusline`,
  `bin/record-session-end` and `bin/judge-updates`, separate scripts the
  dashboard's Claude Code mod runs (see "Plan usage" above); they write only
  `rate-limits.json`, the per-session snapshots in `cc-dashboard/sessions/`, and,
  through `bin/judge-updates`, `cc-dashboard/updates.json`. The mod itself writes the
  activity files (see "Live state"), and `lib/activity.js`
  deletes those older than a day. The mod also writes the setup change markers in
  `cc-dashboard/changes/` and the stored setup copies in `cc-dashboard/setup/` (see
  "Setup changes recorded automatically"). The other write path is the Apply
  button in the Cost by model panel: clicking it is the only thing that writes
  `prices.json`. The third write path is the transcript database,
  `~/.claude/cc-dashboard/transcripts.db` (or
  `$CLAUDE_CONFIG_DIR/cc-dashboard/transcripts.db`). `server.js` writes the usage
  rows of each transcript last modified before today. `bin/review-session` writes
  the session reviews and their suggestions. Nothing deletes rows from it, because
  it holds the only copy of a transcript Claude Code has deleted. The fourth write
  path is the Done, Not useful and Undo buttons in Session reviews. They call `POST`
  and `DELETE /api/reviews/:sessionId/suggestions/:idx/dismiss`, which set or clear
  `dismissed_at` and `reason` on one row of `suggestions`. The routes refuse
  cross-site requests, like the price routes. Nothing else under `server.js` or
  `public/` writes anything.
- **One network request from the server, on demand.** The Cost by model panel has
  a Check prices button. Clicking it makes the server fetch
  `https://platform.claude.com/docs/en/about-claude/pricing.md`, Anthropic's
  pricing page as markdown. Nothing fetches on page load, on a timer, or at
  startup. The URL is a constant in `lib/price-fetch.js`. The page's
  Content-Security-Policy blocks the browser from contacting any other host, so
  the request always comes from the server. The bar charts are hand-drawn SVG (see
  `public/app.js`), so no charting library comes from a CDN.

  Separately, the Claude Code mod fetches the Claude Code changelog from
  `raw.githubusercontent.com` and makes one Haiku call per 20 versions, only when
  the running Claude Code version has no verdict or when you run
  `/backfill-updates`. That request comes from Claude Code, not from the
  dashboard server.
- **Localhost only.** The server binds to `127.0.0.1` and rejects any request whose
  `Host` header isn't `localhost`/`127.0.0.1`, which blocks the DNS-rebinding trick
  where a malicious website re-points its own hostname at your machine (see
  `lib/net-guard.js` for the full explanation). There's no login, so don't change
  the bind address to something network-reachable unless you understand that
  trade-off.
- **Pricing is an estimate, with a dated history.** `lib/pricing.js` has a built-in
  price table, last checked against Anthropic's pricing page on 2026-09-28. Check
  prices lists new models and changed prices and changes nothing. Apply saves them
  to `~/.claude/cc-dashboard/prices.json` with an effective-from date. A changed
  price applies to usage from that date on, and older usage keeps the price it had.
  A new model is priced for all dates. A page that does not parse is refused with
  the reason, and prices stay as they are. Any model the table does not recognize is
  still counted in token totals but shown as "unpriced" rather than silently costed
  at $0.

## File layout

```
server.js              Express app: binds to localhost, serves /api/summary, /api/rtk, /api/changes, /api/limits, /api/records, /api/sessions/live, /api/reviews, the dismiss route (/api/reviews/:sessionId/suggestions/:idx/dismiss) and the price routes (/api/prices, /api/prices/check, /api/prices/apply)
lib/scan.js            Finds the transcripts under ~/.claude/projects, and scanUsage, which reads all of them once
lib/extract.js         Turns one transcript into rows: calls, tool uses, tool errors, edits, prompts and per-session summaries
lib/aggregate.js       Turns the rows of many transcripts into totals by day, model, tool and session
lib/rowstore.js        Keeps each transcript's rows in memory, re-reads a transcript only when it changes, and stores settled ones
lib/store.js           The transcript database, transcripts.db, through node:sqlite
lib/rtk.js             Reads rtk's history.db read-only, aggregates by day and command
lib/efficiency.js      Session start, Bash result and per-prompt statistics per time window
lib/changes.js         Setup change markers: plugin installs, new models, Claude Code releases, the mod's setup changes, changes.json
lib/limits.js          Plan usage limits from the .claude.json usage cache and the statusline rate-limits file
lib/pricing.js         Built-in price table, dated price versions, cost calculation
lib/price-store.js     Applied price history in prices.json
lib/price-fetch.js     Fetch and parse Anthropic's pricing page
lib/net-guard.js       Host-header check + security headers
lib/sessions.js        Per-session snapshots from the statusline, and today's live sessions
lib/activity.js        Live state of each session, read from the activity files the mod writes, and old files pruned
lib/db.js              Opens transcripts.db: schema, WAL mode, busy timeout
lib/sqlite.js          Loads node:sqlite without its experimental-feature warning
lib/review-db.js       Opens transcripts.db for reviews and imports the old review files once
lib/review.js          Session reviews: transcript digest, Haiku prompt and reply parsing, claims and results in transcripts.db
bin/record-statusline  Reads statusLine JSON from stdin, writes the rate-limits file and a session snapshot
bin/record-limits      Old name for bin/record-statusline, kept as a wrapper
bin/record-session-end Marks a session snapshot ended, from SessionEnd hook JSON on stdin
bin/judge-updates      Lists Claude Code versions to judge and records Haiku's verdicts in updates.json
bin/review-session     Lists ended sessions to review and records Haiku's suggestions in transcripts.db
mod/                   Claude Code mod that runs the recorders, records live session state, judges new Claude Code releases and records setup changes
public/index.html      Page shell
public/style.css       All styling
public/app.js          Fetches /api/summary, /api/rtk, /api/limits, /api/sessions/live, /api/reviews, /api/changes, /api/records and /api/prices, draws the SVG charts, has the Check prices / Apply controls, no dependencies
public/hud.js          Display helpers for the header status strip and the Plan usage Today meter
public/chart-geometry.js  X-axis label spacing, tooltip placement, donut slices and the Session timeline's hour ticks and lane layout
public/visibility.js   Parses the hidden panel list and decides which requests hidden panels still need
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
