# Better session titles

Give each session a title that says what the session is for, and show its project and
branch next to it. Asked for on 2026-10-07.

## What was asked for

- **A better purpose title.** The title today is Claude Code's own: the last
  `ai-title` line in the transcript, which Claude Code writes with Haiku. The user
  wants a better one. It does not have to come from Haiku.
- **Project and branch stay visible.** Whatever writes the title, the row still shows
  the session's project and git branch.

## Shipped on 2026-10-07

- The Running now and Today tables, the timeline tooltip and the review head show
  `project · branch` under the title. The branch comes from the transcripts'
  `gitBranch`.
- A session with no `ai-title` shows its first typed prompt as the title, in dimmer
  italic type.
- A title written by the mod with a model call was put off. Decide after a week of
  use (around 2026-10-14) whether the branch line makes Claude Code's titles good
  enough.

## Where titles show today

- `lib/extract.js` reads the last `ai-title` line per session into `titleBySession`.
  `lib/review.js` reads the same line for session reviews.
- `buildLiveSessions` in `lib/sessions.js` puts it on each session as `title`.
- `public/app.js` shows it in three places, each with `contextLine` under it:
  - the Running now and Today tables (`sessionCell`);
  - the timeline bar tooltip;
  - the review head (`.review-head`).
- With no `ai-title`, a live session shows its first typed prompt. A review with no
  title shows the project and branch alone.
- The branch is read from the transcripts' `gitBranch` in `lib/extract.js`. The project
  comes from the mod's session snapshot (`projectName` in `lib/sessions.js`).

## Open questions

- **Where a title comes from.** Candidates:
  - the first typed prompt, trimmed (shipped as the fallback when there is no
    `ai-title`);
  - the mod's own model call at session end, like the session review in
    `bin/review-session`;
  - a title the user sets with `/rename`.
  Calls made by the mod write no transcript line, so their cost is missing from the
  dashboard's totals (see the README's session review notes).
