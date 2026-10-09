# Group Today's sessions by launch

Group the Today table's rows by the `claude` launch they came from, so every session
started inside one Claude Code process shows under one row. Asked for on 2026-10-09.

## What was asked for

- One `claude` launch is one piece of work. Each `/clear` inside it starts a new
  session id, but those sessions are usually related.
- Everything that happens in one launch should show under one row of the Today table.

Example from 2026-10-09: "C17 models PR handoff" (cleared) and "C17 models PR C
handoff" (live) show as two rows. Both are on `f-forge.c17-integration · c17/models/pr-c`,
and the second most likely followed a `/clear` in the first.

## How rows group today

- `groupSessions` in `public/session-groups.js` builds the Today table's rows.
- It groups only ended sessions, and groups them by project. A project needs two or
  more ended sessions to get a group row.
- Live sessions and idle open sessions stay plain rows. So the live session that a
  `/clear` started never joins the group of the session it replaced.
- A group row shows counts such as "2 cleared · 1 ended". It does not say which
  sessions came from the same launch.

## What could link sessions of one launch

- **The mod.** The mod runs inside the Claude Code process. A `/clear` reaches it as
  `session.end` with reason `clear`, and the process keeps running. No
  `session.start` follows (see the comment above `on('session.end', …)` in
  `mod/hooks/register.ts`). The mod could make one id per process when it loads,
  and write that id into every session snapshot `bin/record-statusline` writes.
  Sessions with the same id came from the same launch.
- **The transcripts.** Unknown whether the transcript a `/clear` starts names the
  session before it. Check the first lines of such a transcript.
- **A timing match**, for the route without the mod. Same project and branch, and the
  new session's first transcript line within a few seconds of an `endedAt` with
  `endReason: 'clear'`. This guesses wrong when two terminals work on the same branch.

## Open questions

- Check that the mod keeps its module state across a `/clear`. Check whether a mod can
  read the process id, or must make its own id.
- An in-process `/resume` (reason `resume`) can load a session from another day.
  Decide whether it joins the launch's group.
- Which title the group row shows: the newest session's, the first session's, or the
  project and branch alone.
- How a group that holds a live session shows that it is live. It must use the
  existing glyph shapes (filled and hollow hexagon), not colour alone. The owner is
  red-green colourblind.
- Whether a project's ended sessions from different launches still group by project
  under the launch groups, or each launch becomes its own row.
- Whether the Running now table and the session timeline group by launch too.
- What adds or changes a path the mod writes. `SETUP.md` needs updating if the
  snapshot format or a file under `<cfg>/cc-dashboard/` changes.
