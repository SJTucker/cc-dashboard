# Dimension: review quality

Question: did review catch what it should, and why did reviews fail?

Follow the first two items of the reading order in
`docs/orchestrate-run-review.md` in the clone, using the `MISSES` and `REPORT` output in
the case file.

Look for:
- Each `Candidates:` row and each `Final-review fixes:` entry on a task that passed review.
  Open the commit with `git show --stat <sha>` and classify it as a real miss or later work
  on a shared file.
- For each real miss, the reviewer's transcript steps around the area the commit changed:
  did the reviewer read that file, run the `doneWhen` command, or skip it?
- Each `review-fail` event: the cause in its text and in the next attempt's `notes` in
  `<run>/claimed/`. A cause that repeats across tasks points at a gap in the task fields
  or the image.
- Tasks with `attempts` over 1 and what changed between attempts.
- `<leftovers>` entries: problems a passing review listed and left unfixed.

Name the reviewer's brief line (in `~/.claude/agents/orch-reviewer.md` or the reviewer
message in `skills/orchestrate/SKILL.md` section 11) that would have caught each real miss.
