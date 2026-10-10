# Where the time goes

Show how long turns take, from the `turn_duration` lines Claude Code writes. The
dashboard counts tokens and dollars, and has no measure of time spent beyond session
length. Recorded on 2026-10-10.

## What exists

- Claude Code writes a `system` line with subtype `turn_duration` at the end of each
  main-loop turn, carrying `durationMs` and `messageCount`. The transcripts on this
  machine held 2,987 such lines on 2026-10-10. Nothing in `lib/` reads them.
- The session snapshot from the statusline holds `durationMs` and `apiDurationMs` for
  the whole session (`lib/sessions.js`). The difference is time not spent waiting on
  the API: tools, hooks and the user.
- The Session timeline builds activity bars from call times, with a 10-minute gap
  rule.

## What it could show

- Hours of model work per day: the sum of turn durations.
- The distribution of turn length, so a setup change that makes turns longer or
  shorter can be seen. A Setup changes table row for median turn duration.
- The longest turns of the range, with their session, as a list.
- Per session, model time against wall time, which says how much of a session was
  spent waiting on the user.

## Open questions

- Whether `turn_duration` covers subagent time that runs in the background after the
  main turn ends.
- Whether tool time can be split out. A tool's time is the gap between its
  `tool_use` line and its `tool_result` line, both timestamped.
- A new row kind in `lib/extract.js` raises `EXTRACT_VERSION`.
