# Dimension: scheduling

Question: where did the run wait, and was that avoidable?

Read `events.jsonl` for `ready`, `added`, `claimed`, `merged`, `waiting` and `answered`
events, and the schedule the orchestrator wrote in the orchestrator transcript
(`skills/orchestrate/SKILL.md` section 5).

Look for:
- A task that was `ready` for a long time before a worker `claimed` it, while fewer than 3
  workers ran.
- Idle slots: times when fewer than 3 workers ran and a ready task existed.
- A task started before the task it depends on merged, or a ready task held back with no
  reason in the transcript.
- Time between a worker's DONE and its review starting, and between a review pass and
  the merge.
- Time spent in `waiting` (owner questions), from the `waiting` and `answered` events.
- Whether the 3-worker cap held. Count overlapping claimed-to-merged windows.

Report each wait with its start and end timestamps from the event log.
