# Cache keep-alive while a subagent runs

Claude Code keeps the main thread's prompt cache warm while a subagent runs. The
dashboard and the mod work out the cache expiry from the transcript, which does
not record the keep-alive requests. Recorded on 2026-10-23, after the statusline's
cache line looked stuck at "cache 4 min left" during a background-agent wait.

## Background

Claude Code 2.1.309 has a cache keep-alive sender. It was found with `strings` on
the binary in `~/.local/share/claude/versions/2.1.309`.

- After a main-thread request, a timer POSTs `{ request_id }` to the API with
  client source `cache_touch`. The interval comes from a remote flag
  (`touchIntervalSeconds`). It was 30 s in the sessions checked.
- The sender keeps going while Claude Code's work state is `turn_running` or
  `subagent_running`. It stops during compaction. Otherwise it stops after an
  activity window (`activityWindowMinutes`, from the same flag).
- It runs only when the policy allows `allow_cache_keepalive`, and not behind a
  Unix socket, a CCR session profile or some other settings.
- Each successful touch calls the prompt cache ledger's `touch`. That moves
  `prompt_cache.expires_at` in the statusLine JSON. `requests` does not change,
  and no line is written to either transcript.

This was observed in a test. A background agent ran `sleep 90`. The statusline
script ran every 15 s throughout. `expires_at` moved about 30 s forward every
30 s. Neither the main transcript nor the agent's transcript held a request at
those times.

The statusline line (`bin/cache-line`, `cacheStatusLine` in `lib/cache.js`) reads
`expires_at` from that JSON, so it is correct. With a 5m TTL it shows
"cache 4 min left" until the agent finishes.

## What is wrong

Three places count the expiry from the newest main-thread call in the transcript,
so they cannot see touches:

- `cacheOf` in `lib/sessions.js`, behind the Live sessions State cell. A session
  waiting on a background agent shows its cache counting down and then expired,
  while Claude Code keeps it warm.
- `bin/cache-state`, which uses the same `cacheOf`.
- The mod's handoff timer (`armHandoff` and `handoffWait` in
  `mod/hooks/register.ts`), which reads `bin/cache-state`. It fires
  `HANDOFF_LEAD_MS` (6 min) before a 1h cache expires. A main thread that waits on
  a background agent for more than about 54 min gets a handoff fork for a cache
  that is still warm.

## Open questions

- Whether the touch request reads the cached prefix, so the API resets the TTL, or
  only renews a server-side record. The ledger treats a touch as a renewal.
- What `activityWindowMinutes` is, and so how long touches go on once the
  subagent has finished.
- Whether touches run for a 5m TTL. `NCt` in the binary gates one header on
  `ttl === '1h'` and a subscriber login. The test session still had `expires_at`
  move while its transcript showed 5m cache writes.
- Where the mod and the server could learn that touches are running. The
  statusLine JSON has the moved `expires_at` but no keep-alive field. The mod's
  engine events are not known to report touches, and `session.measure`, which
  feeds `bin/record-statusline`, carries no `prompt_cache`. Only the statusLine
  command sees it, and `bin/cache-line` is run from the user's own statusline
  script and stores nothing. One option is for `bin/cache-line` to write
  `prompt_cache.expires_at` per session under `<cfg>/cc-dashboard/`, so `cacheOf`
  can take the later of that value and its own. That adds a file SETUP.md would
  list.
- Whether Claude Code's idle compaction, which the handoff timer copies, counts
  touches. If it does not, the handoff timer matches it and only the State cell
  needs a fix.
