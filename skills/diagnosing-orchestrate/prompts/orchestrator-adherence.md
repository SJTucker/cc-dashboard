# Dimension: orchestrator adherence

Question: did the orchestrator follow `skills/orchestrate/SKILL.md` sections 5 to 14?

Read those sections in the clone first. Then read the orchestrator transcript through
`TI <orchestrator transcript>` and the line ranges it names, together with
`events.jsonl`.

For each section, check the rules that the problem statement could touch:
- 5 and 6: the schedule, the 3-worker cap, the worker message and the dispatch commands,
  the `ready` events.
- 7 and 8: the watches armed, each watch event handled as the section says.
- 9 and 10: board posts answered, steers logged with `EVENT ... steer`.
- 11 and 12: the reviewer started per finished worker, the full review read before
  `review-pass` or `review-fail`, the merge check.
- 13 and 14: feedback entries, the final review, and `EVENT final-review`.

Report each deviation with the transcript line and the skill section it departs from. Then
state whether the skill text is unclear at that point (change the skill) or the
orchestrator ignored a clear rule (no skill change).
