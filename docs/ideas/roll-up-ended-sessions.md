# Roll up cleared and ended sessions per project

In the Live sessions panel, show one row per project for its cleared and ended
sessions, and list them one by one only when that row is clicked. Asked for on
2026-10-06.

## What was asked for

- **One row per project** holds every session of that project that was cleared or
  ended. Live sessions are left out of the roll-up.
- **Clicking the row expands it** into the individual session rows it holds. Clicking
  again collapses it.

## Where the rows come from now

- **One row per snapshot.** `renderSessions` in `public/app.js` draws one `<tr>` per
  entry in `/api/sessions/live`. `buildLiveSessions` in `lib/sessions.js` builds
  those entries, one per file in `cc-dashboard/sessions/`.
- **A `/clear` adds a row.** A `/clear` ends one session id and starts another, so a
  project cleared five times today has six rows.
- **The state is a suffix.** `sessionState` in `public/app.js` adds " · cleared" or
  " · ended" to the Last active cell, from the entry's `ended` field.
- **An expand control exists.** The Subagents group in the usage panel uses a
  `button.row-toggle` with `aria-expanded` and `aria-controls`. The roll-up row can
  use the same pattern.

## Open questions

- **How the roll-up row adds up.** Session cost, Lines, Cost today and Tokens today
  can be summed. Session length can be summed too, because the sessions of one project
  usually ran one after another. Concurrent sessions in the same project would make
  that sum longer than the wall time.
- **Model column.** The sessions in one roll-up can use different models. Options:
  the most recent model, "mixed", or a count such as "2 models".
- **Last active.** The latest end time of the sessions in the roll-up, with a count,
  for example "10:42 · 4 ended".
- **Grouping key.** Rows group by `project`, the basename of the project folder. Two
  repos with the same folder name would merge. Worktrees of one repo have different
  folder names and would not.
- **A project with one ended session.** Decide whether one session still gets a
  roll-up row, or stays a plain row.
- **Remembering what is expanded.** The panel redraws on every load. Keep the expanded
  projects in a variable so a reload does not collapse them, and decide whether that
  state survives a page reload.
- **Session reviews panel.** The Session reviews panel also lists one entry per
  session. Decide whether it groups by project the same way.
