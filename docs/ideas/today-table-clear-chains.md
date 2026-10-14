# Today table: group sessions by /clear link

The Today table groups sessions with the same `launchId`, the mod's id for one claude
process (`groupSessions` in `public/session-groups.mjs`). That misses a session that is
resumed in a new process and cleared before the new process sends a measure for it.
The old session's snapshot keeps the first process's `launchId`, and the session the
`/clear` started gets the new one. Found on 2026-10-11 with a `claude --continue`
followed by `/clear`.

## What exists

- Each row of `/api/sessions/live` carries `sessionId` and `clearedFrom`, the session
  a `/clear` ended to start it (`recordSession` and `buildLiveSessions` in
  `lib/sessions.js`).
- The Session timeline already follows `clearedFrom` (`clearParents` and `laneLayout`
  in `public/chart-geometry.js`).

## Open questions

- Whether a group joins on `clearedFrom` as well as on `launchId`, or on
  `clearedFrom` only.
- Which session's title the group row shows when a chain spans two processes.
