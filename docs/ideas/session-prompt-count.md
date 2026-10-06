# Prompts per session

Show how many prompts the user typed in each session in the Live sessions panel.
Asked for on 2026-10-06.

## What was asked for

- **A prompt count per session.** Each row of the Live sessions table
  (`#sessionsTable`, drawn by `renderSessions` in `public/app.js`) shows how many
  prompts that session had.

## Where the data comes from now

- **Prompts are already counted.** `recordPrompt` in `lib/scan.js` pushes one
  `{ t, sessionId }` per typed prompt into `efficiency.prompts` on every scan.
  `isTypedPrompt` decides what counts: typed and queued prompts from the user. Tool
  results, subagent task prompts, task notifications, meta lines and slash-command
  wrappers are left out. A resumed session's copied lines are skipped by
  `seenPromptIds`.
- **The live endpoint does not pass them.** `/api/sessions/live` in `server.js` calls
  `buildLiveSessions(readSessions(), data.efficiency.calls, Date.now(),
  data.efficiency.linesBySession)` with the Today scan. `buildLiveSessions` in
  `lib/sessions.js` already joins calls and lines by session id. Prompts can be
  joined the same way.
- **Prompts are used elsewhere.** `promptStats` in `lib/efficiency.js` turns them into
  cost per prompt and API calls per prompt for the Setup changes panels.

## Open questions

- **Today or the whole session.** The Today scan only holds today's prompts, so the
  easy count matches Cost today and Tokens today. A count for the whole session, to
  match Session cost and Session length, needs either the all-history scan
  (`getCached(null)` in `server.js`, which is slow) or a counter in the mod's session
  snapshot.
- **Column or cell.** A new "Prompts" column makes the table eight columns again, now
  that Model is gone. The count could instead go in an existing cell, for example
  the Session length cell as "50m · 12 prompts".
- **Roll-up rows.** The project roll-up row from `groupSessions` in
  `public/session-groups.js` sums its sessions. The prompt count should sum the same
  way, and the Total row should show the sum.
- **Derived figures.** With a prompt count, cost per prompt per session is one
  division away. Decide whether to show it, or leave that to the Setup changes panels.
- **Slash commands.** `/clear`, `/model` and other slash commands are not counted as
  prompts. A slash command that expands into a prompt, such as a skill, is also left
  out, because its line starts `<command`. Decide whether skill invocations should
  count.
