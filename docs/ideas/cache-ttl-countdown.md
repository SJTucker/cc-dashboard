# Cache expiry countdown

In the Running now table, show how long a session waiting on you has before its
prompt cache expires. Recorded on 2026-10-10, from the second round of research
(ccstatusline has a cache timer widget).

## Why

A reply after the cache expires pays to write the whole context to the cache again
(the Session timeline marks each rebuild). A session at 150k of context that has
waited 4 minutes on a 5-minute TTL is worth answering now, or worth a `/clear` before
the next prompt.

## What exists

- Running now shows ⏸ waiting on you and Last active per session
  (`public/panels/sessions.mjs`).
- Each call's cache write is split into `ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens`, which says which TTL the session's last call wrote.

## Open questions

- Whether a cache read refreshes the TTL as well as a write. Anthropic's prompt
  caching docs say a hit refreshes it, which needs a check.
- What to show past expiry: the cost the next reply will pay to rebuild, at the
  session's current context size.
- Whether the countdown belongs in Claude Code's statusline through the mod, where
  the user is looking, instead of on the page.
