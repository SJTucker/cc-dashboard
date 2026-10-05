# Review each session for suggested improvements

When a session ends or `/clear` runs, have a model read the session's transcript
and suggest improvements to the Claude Code setup or the way the session was run.
"No suggestions" must be a valid result, so the model never invents one to fill the
slot. Asked for on 2026-10-05.

## What was asked for

- **The trigger** is a session ending, or `/clear`, which ends one session id and
  starts another.
- **A model analyses the transcript** of the session that just ended.
- **The result can be empty.** The prompt and the output format must allow "no
  suggestions", and the dashboard shows that as a normal result, not an error.

## Constraints found so far

- **`session.end` is short.** It gives every hook and Claude Code's own handling
  1.5 s together (`END_TIMEOUT_MS` in `mod/hooks/register.ts`). A model call cannot
  finish inside it.
- **After a real exit the process is gone.** After `/clear`, the same process goes
  on with a new session id, so a timer (`$.clock.after`) can run the review. After an
  exit, nothing is left to run it. One option: `session.end` records the ended
  session id in a queue file through a `bin/` script, and the next `session.start`
  reviews whatever is queued.
- **`$.model.complete` has no history.** The transcript text has to go into the
  prompt. A long session can exceed the model's context, so the transcript needs
  cutting down first, for example to prompts, tool names, tool errors and
  compactions.
- **`$.model.fork` reuses the session's own context** and its prompt cache. It
  answers `nothing-to-fork` after `/clear`, and it may not be usable once
  `session.end` has fired. Whether it can run before the session ends is not
  verified.
- **Claude Code updates already use this pattern.** The update-judging work
  (`bin/judge-updates`) has the mod call Haiku and a `bin/` script write the result,
  and this idea can follow it.

## Open questions

- **What counts as an improvement.** Candidates: CLAUDE.md rules that would have
  prevented a correction, a skill or hook that would have saved repeated steps, and
  token waste such as large tool output or repeated reads.
- **Which model.** Haiku is cheap but may give shallow suggestions. Sonnet costs more
  per session.
- **Where suggestions appear.** Options: a dashboard panel, a file per session under
  `~/.claude/cc-dashboard/`, a line at the next session start, or `docs/ideas/`.
- **Cost control.** Decide whether to skip sessions under a size threshold, and
  whether `/clear` on a near-empty session triggers a review.
- **Privacy.** Transcripts can hold secrets. The review runs on the user's own login,
  but the stored suggestions should not quote transcript text.
