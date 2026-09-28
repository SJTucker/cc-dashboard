# Live sessions panel

On the Today range only, show a panel of the Claude Code sessions active right now.
Each session gets the same figures as the Session block of Claude Code's `/usage`
screen: cost, API duration, wall duration, lines added and removed, and token usage.
A total row sums the active sessions.

## Where the data comes from

- **The transcripts can't supply it live.** Claude Code writes its `cost-state` line
  (`totalCostUSD`, `totalLinesAdded`, `totalLinesRemoved`, `totalDuration`,
  `totalAPIDuration`, `modelUsage`) when a session ends or is cleared, not while it
  runs. One session checked on 2026-09-28 ran for 3h 20m and had its full totals in a
  single `cost-state` line written at `/clear`.
- **The statusline input can.** After every API response, Claude Code sends the
  statusline command JSON with `session_id`, `model`, `workspace`, `context_window`
  and a `cost` block: `total_cost_usd`, `total_duration_ms`, `total_api_duration_ms`,
  `total_lines_added`, `total_lines_removed`. The user's statusline already pipes
  that JSON into `bin/record-limits`.
- **Tokens per session** can come from the Today scan that already runs, grouped by
  `sessionId`. `efficiency.calls` in `lib/scan.js` already carries a `sessionId` on
  each call.

## Sketch

1. `bin/record-limits` also writes each session's snapshot to its own file, for
   example `~/.claude/cc-dashboard/sessions/<session_id>.json`, holding the `cost`
   block, model, working directory and a timestamp. Writing one file per session
   means concurrent sessions never race on the same file. The script deletes
   snapshots older than a day. Since the script would then record more than limits,
   rename it to `bin/record-statusline`.
2. `GET /api/sessions/live` reads the snapshot directory and returns the sessions
   updated in the last N minutes, joined with their token totals from the Today scan.
3. A panel on the Today range lists each active session (project directory, model,
   cost, duration, lines ±, tokens) and a total row.

## Size

Medium. Three pieces, each small, and each follows a pattern the repo already has:
the statusline capture, a read-only route, and a Today-only panel.

## Open questions

- **What counts as active.** The statusline only renders when a session does
  something, so a session that is open but idle looks the same as a closed one.
  Pick a window, such as updated in the last 10 minutes, or show every session
  updated today with its last-activity time.
- **Sessions with no statusline** are not listed: `claude -p` runs, and any machine
  without the `record-statusline` line. Subagent cost is already inside the parent
  session's `cost` block.
- **Renaming the script** means changing the line in `~/.claude/statusline.sh` too.
  Keeping `bin/record-limits` as a wrapper for one release avoids breaking a
  statusline that still calls the old name.
