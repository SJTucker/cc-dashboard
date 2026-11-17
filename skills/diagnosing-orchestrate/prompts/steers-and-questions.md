# Dimension: steers and questions

Question: which steers and owner questions show a gap in the plan or the image?

Read the `steer`, `waiting`, `answered` and `review-fix` events in `events.jsonl`, the
`Steers:`, `Questions:` and `Review fixes:` lines of `REPORT`, `<board>` posts, and
`<feedback>`.

Look for:
- A steer that repeats across tasks, or repeats a fact the image could hold.
- A question a worker asked on the board that the plan or image answered elsewhere, or
  should have answered.
- Time each question waited (`Waiting` column).
- A review fix that restates a plan requirement the worker missed.

For each, quote the steer or question text with its event line in `events.jsonl` or its
board line, and name the section of `skills/orchestrate/image-template.md` or the plan
task field that should have carried the fact.
