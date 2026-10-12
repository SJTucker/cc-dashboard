# Handoff before the cache expires

Write a handoff automatically when a session's prompt cache has 3 minutes left and
its context is more than 20% full. A later session can then start from the handoff
instead of paying to write the whole context back into the cache. Recorded on
2026-10-12.

## What exists

- `cacheOf` in `lib/sessions.js` computes each waiting session's cache TTL (`5m`
  or `1h`), `expiresAt`, `minutesLeft` and `rebuildUsd` from the main thread's
  calls. It runs in the server, on the dashboard's poll, and nothing acts on it.
- The `/handoff` skill in `~/.claude/skills/handoff/` writes the document to
  `<worktree-root>/.claude/handoffs/<timestamp>-<branch-slug>.md`. On 2026-10-12
  its frontmatter changed to `disable-model-invocation: false`, so the model can
  start it during a turn. An idle session has no turn, so something still has to
  start one.
- The mod listens for `session.measure`, `turn.start` and `turn.complete` in
  `mod/hooks/register.ts`, and already keeps per-session timers.
- Each stored call has a `context` token count. The mod reads the model id with
  `$.session.model()`, which gives the window size (200k, or 1M for a `[1m]` id).

## Open questions

- How the handoff turn gets started. The mod can show a toast or a band, but no
  mod API is known that submits a prompt or runs a skill in the session. Options: a toast
  telling the user to run `/handoff`, a mod `model()` call that writes the handoff
  from the transcript outside the session, or a way to submit `/handoff` that is
  not found yet.
- Whether the trigger lives in the mod or the server. The mod sees
  `turn.complete` and can start a timer for TTL minus 3 minutes. The server knows
  the TTL from `cacheOf` but has no way to reach the session.
- 5-minute TTL sessions. 3 minutes left is 2 minutes after the turn ends, so the
  handoff would fire on most pauses. It may only suit `1h` sessions.
- A handoff written inside the session is itself a turn. It reads the full context
  from the cache and resets the TTL, so it costs a cache read and moves the
  expiry, which the trigger must not count as a new idle gap.
- How the 20% is measured: the newest main call's `context` over the window size
  from the model id, or the statusline's own context reading if the measure event
  carries one.
- Repeats: once per idle gap, and none when a handoff was already written since
  the last turn.
