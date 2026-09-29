# Live sessions: Cost today above Session cost

On 2026-09-29 the Live sessions panel showed a new cc-dashboard session with Session
cost $0.39 and Cost today $0.48. Split out of
[live-sessions-after-clear.md](live-sessions-after-clear.md) on 2026-09-29.

## What was seen

In the same screenshot, the new cc-dashboard session showed Session cost $0.39 and
Cost today $0.48. A 51-second session cannot cost more today than in total. Possible
causes: the statusline snapshot lagging the JSONL scan, or subagent tokens counted in
the JSONL but not in the statusline's `cost.total_cost_usd`. Not investigated.

## Where the two numbers come from

- **Session cost** is `cost.total_cost_usd` from the statusline input, stored in the
  session's snapshot by `recordSession` in `lib/sessions.js`.
- **Cost today** is the sum of today's per-call costs for that session id from the
  JSONL scan, joined in `buildLiveSessions` in `lib/sessions.js`.

## Open questions

- Is the gap the snapshot lagging the scan, or a real difference in what each source
  counts (for example subagent calls)?
- If the sources differ on purpose, which one should the panel show, or should it
  say which is which?
