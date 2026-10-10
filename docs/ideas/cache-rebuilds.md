# Cache rebuild cost

Find the calls that wrote most of the context to the prompt cache again in the middle
of a session, and show what those rebuilds cost and why they happened. Recorded on
2026-10-10.

## Why

A call after an idle gap longer than the cache TTL pays the cache-write price on the
whole context instead of the cache-read price. In the price table in
`lib/pricing.js`, an Opus 5.5 cache write costs 25 times a cache read at the 5-minute
TTL, and 40 times at the 1-hour TTL. A session left
idle for lunch at 150k of context pays that once on return. The dashboard shows
cache-write tokens per day but not which calls were rebuilds or what caused them.

## What exists

- Each call row carries cache-write and cache-read tokens. `lib/pricing.js` already
  splits cache writes into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.
- Call rows carry a timestamp and a session, so the gap since the session's previous
  call is known.
- `lib/efficiency.js` computes a context delta between consecutive calls.

## Possible approach

A call is a rebuild when its cache write is most of its context and the session's
previous call was cached. The cause is one of:

- a gap since the previous call longer than the TTL the previous call wrote with;
- a compaction or `/clear` just before it (a `compact_boundary` line);
- a model change between the two calls;
- none of these, which points to a change in the system prompt or tool list.

Show rebuild cost per day, the share of all cache-write cost it makes up, and the
cause split. A tooltip could name the cost of the single largest idle-gap rebuild.

## Open questions

- The threshold for "most of its context": a fixed share, such as 80%, or the context
  size minus the previous call's cache read.
- Subagent calls start with a cold cache by design. Leave them out, or count them
  separately.
- Where it shows: a row in Where usage goes, a Setup changes table row, or a panel.
