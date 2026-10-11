# Cache expiry countdown

In the Running now table, show how long a session waiting on you has before its
prompt cache expires. Recorded on 2026-10-10, from the second round of research
(ccstatusline has a cache timer widget).

## Why

A reply after the cache expires pays to write the whole context to the cache again
(the Session timeline marks each rebuild). A session at 150k of context that has
waited 4 minutes on a 5-minute TTL is worth answering now, or worth a `/clear` before
the next prompt.

## Shipped 2026-10-11: Running now

A session waiting on you shows a second line under "⏸ waiting on you":

- `cache 4 min left · $0.38 to rebuild after`
- `cache expires in under 1 min · $0.38 to rebuild after`
- `cache expired · next reply pays $0.38 to rebuild`

The cost clause is left out for an unpriced model. Sessions that are working, or
that have no mod activity, show no line.

How it is worked out (`cacheOf` in `lib/sessions.js`, `cacheLine` in
`public/session-groups.js`):

- The TTL comes from the session's main-thread calls in time order, using `nextTtl`
  from `lib/extract.js`: a 1-hour write gives 1 hour, a 5-minute write gives 5
  minutes, and a pure read keeps the earlier TTL. Subagent calls are ignored.
- The cache expires at the newest main call's timestamp plus the TTL.
- The rebuild cost is the newest main call's context written at the TTL's write
  price, minus the same tokens read, at today's price.
- The page has no timer. `minutesLeft` changes in the payload once a minute and the
  5 s poll redraws it.

Known limits:

- The countdown counts from the transcript line's timestamp. The API counts the TTL
  from the start of the request, so the real expiry can be earlier than shown by up
  to the response time.
- It assumes a cache read refreshes a 1-hour entry to a full hour. The prompt
  caching docs do not state this for 1-hour entries.
- `/api/sessions/live` reads the Today scan, so `cacheOf` sees today's calls only. A
  session that has waited since before midnight shows no line, though its cache has
  expired and the rebuild cost would still apply.

## Shipped 2026-10-11: statusline

`bin/cache-line` prints `cache 4 min left · rebuild $0.38` for a statusline
script, from the `prompt_cache` block Claude Code sends the statusline command
(`cacheStatusLine` in `lib/cache.js`). SETUP.md has the setup. Claude Code computes
`ttl` and `expires_at` itself, so the statusline needs none of the page's
transcript work. The rebuild is priced from `recache_tokens_if_cold` with the same
`rebuildUsd` as the page.

A mod could not draw this line. `$.ui.status` draws above the statusline with a
`⚠ <plugin>:` prefix, and the `PromptHint` tail draws at the end of the mode row.

## Open questions

- The page could read `prompt_cache.expires_at`, `expected_rebuilds` and
  `miss_causes` in place of transcript timestamps and the `nextTtl` guess. Only
  the no-mod route's `bin/record-statusline` sees that JSON. The mod builds its
  own statusline-shaped input in `statuslineInput` (`mod/hooks/register.ts`),
  which has no `prompt_cache`.
