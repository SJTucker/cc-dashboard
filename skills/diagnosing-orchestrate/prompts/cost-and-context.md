# Dimension: cost and context

Question: where did the money and context go?

Use the `REPORT` output in the case file, and `REPORT <image> --json` for exact fields.

Look for:
- Cost by role: `Impl`, `Review` and the `Final review` line. A reviewer that costs more
  than its implementer, or a final review that costs more than the tasks it checks.
- Peak context over 150,000 tokens on any agent, and the steps where it grew
  (`TI <transcript> --steps <n>` shows the large reads).
- First-request cache share (`1st cache`) under 50%. A miss is expected when the previous
  agent on the same model started more than 5 minutes earlier. For a miss within 5
  minutes, the shared prefix did not match: check the list of what must match in
  `docs/adr/0001-orchestrate-workers-share-one-prompt-prefix.md`.
- Tasks with several attempts: their summed cost against a single-attempt task.
- The orchestrator's own context and cost, from `TI <orchestrator transcript>`.

State each number with the REPORT row it came from.
