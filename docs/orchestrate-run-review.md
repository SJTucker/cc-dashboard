# Orchestrate run review

Run this after an orchestrate run. Each item names the number to read and what to do about it. The thresholds are starting points. Change them when they prove wrong.

## Get the numbers

1. Run `bin/orch-report <image path>` within a day of the run, or read `<run>/report.json`. The server deletes the agent-usage step files a day after their last write. `bin/orch-report` saves its numbers to `report.json` on every run, and a later run keeps the saved costs.
2. Run `bin/orch-misses <image path> --branch <plan branch> --base <base>` inside the plan branch's repository. After the plan branch has merged and been deleted, pass `--branch main --base <merge-base>`.

## Read, in this order, for each task

1. **Reviewer misses.** Any `Candidates:` row from `bin/orch-misses`, and any `Final-review fixes:` entry, on a task that passed review is a review miss. Open the commit and classify it: a real miss, or later work on a shared file. Fix the reviewer's brief for each real miss.
2. **`review-fail` count and `attempts` over 1.** Read the cause in the `review-fail` event text and in the next attempt's `notes` under `<run>/claimed/`. A cause that repeats across tasks points at a gap in the task fields or the image.
3. **Steer texts** (`Steers:` in the report). A steer that repeats across tasks points at a gap in the image. Add the missing fact to the image template.
4. **DRIFT, STUCK, BUDGET and QUIET counts** (the `Watch` column). A count above 0 on several tasks means the task was too large or the image too thin. Split such tasks in the next plan.
5. **Questions with their waiting time** (`Questions:` and the `Waiting` column). Each question is information the plan or the image lacked. Add it there.
6. **Peak context over 150,000, and `Read outside image` entries.** Each file a worker read outside the image is a candidate line for the image's "Read before starting" or "Orientation".
7. **First-request cache share below 50%** (`1st cache`) on a worker or reviewer. The shared prefix did not match. Check the `docs/adr/0001-orchestrate-workers-share-one-prompt-prefix.md` list of what must match, starting with the start folder and the skill listing.
8. **Cost by role** (`Impl`, `Review` and the `Final review` line). Compare the three. A reviewer that costs more than its implementer, or a final review that costs more than the tasks it checks, is a candidate for a cheaper model or a narrower brief.
