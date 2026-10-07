# Better session titles

Give each session a title that says what the session is for, and show its project and
branch next to it. Asked for on 2026-10-07.

## What was asked for

- **A better purpose title.** The title today is Claude Code's own: the last
  `ai-title` line in the transcript, which Claude Code writes with Haiku. The user
  wants a better one. It does not have to come from Haiku.
- **Project and branch stay visible.** Whatever writes the title, the row still shows
  the session's project and git branch.

## Where titles show today

- `lib/scan.js` reads the last `ai-title` line per session into `titleBySession`.
  `lib/review.js` reads the same line for session reviews.
- `buildLiveSessions` in `lib/sessions.js` puts it on each session as `title`.
- `public/app.js` shows it in three places, each with the project beside it:
  - the Running now and Today tables (`sessionCell`, `.session-title` and
    `.session-project`);
  - the timeline bar tooltip;
  - the review head (`.review-head`).
- With no title, those places show the project alone.
- **The branch is not shown anywhere.** Every transcript line carries `gitBranch`, but
  `lib/scan.js` does not read it. The project comes from the mod's session snapshot
  (`projectName` in `lib/sessions.js`).

## Open questions

- **What is wrong with the current titles.** Too generic, stale after the session
  changes direction, or missing for short sessions. The answer decides the source.
- **Where a title comes from.** Candidates:
  - the first typed prompt, trimmed;
  - the mod's own model call at session end, like the session review in
    `bin/review-session`;
  - a title the user sets with `/rename`.
  Calls made by the mod write no transcript line, so their cost is missing from the
  dashboard's totals (see the README's session review notes).
- **Which branch.** A session can switch branches, and a worktree move changes it.
  Decide whether to show the first branch, the last, or every branch the session used.
- **Layout.** Decide whether project and branch share one line under the title
  (`cc-dashboard · main`), and how a long branch name is cut.
