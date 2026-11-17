# Orchestrate run review

Run this after an orchestrate run. Each item names the number to read and what to do about it. The thresholds are starting points. Change them when they prove wrong.

## Get the numbers

1. Run `bin/orch-report <image path>` within a day of the run, or read `<run>/report.json`. The server deletes the agent-usage step files a day after their last write. `bin/orch-report` saves its numbers to `report.json` on every run, and a later run keeps the saved costs.
2. Run `bin/orch-misses <image path> --branch <plan branch> --base <base>` inside the plan branch's repository. After the plan branch has merged and been deleted, pass `--branch main --base <merge-base>`.

## Read, in this order, for each task

1. **Reviewer misses.** Any `Candidates:` row from `bin/orch-misses`, and any `Final-review fixes:` entry, on a task that passed review is a review miss. A final-review fix is a work file with `fix: "final-review"`, or Task 0 in older runs. A candidate row that ends with `(fix task <N>: <title>)` is a commit made while fix task N ran, on one of its files. With a `Leftover fix:` title, the commit fixes a problem a passing review listed, so it is not a miss. With a `Final review fix:` title, the same work also appears in the `Final-review fixes:` list, so count it once. Open every other candidate commit and classify it: a real miss, or later work on a shared file. Fix the reviewer's brief for each real miss.
2. **`review-fail` count and `attempts` over 1.** Read the cause in the `review-fail` event text and in the next attempt's `notes` under `<run>/claimed/`. A cause that repeats across tasks points at a gap in the task fields or the image.
3. **Review fixes and steer texts.** Read `Review fixes:` for causes that repeat across tasks, which point at a gap in the image or the plan. Read `Steers:` for corrections. A steer that repeats across tasks points at a gap in the image. Add the missing fact to the image template.
4. **DRIFT, STUCK, BUDGET and QUIET counts** (the `Watch` column). A count above 0 on several tasks means the task was too large or the image too thin. Split such tasks in the next plan.
5. **Questions with their waiting time** (`Questions:` and the `Waiting` column). Each question is information the plan or the image lacked. Add it there.
6. **Peak context over 150,000, and `Read outside image` entries.** The list leaves out working files, so each entry is a candidate line for the image's "Read before starting" or "Orientation".
7. **First-request cache share below 50%** (`1st cache`) on a worker or reviewer. A miss is expected when the previous agent on the same model started more than 5 minutes earlier, because subagents write a 5-minute cache. For a miss within 5 minutes, the shared prefix did not match. Check the `docs/adr/0001-orchestrate-workers-share-one-prompt-prefix.md` list of what must match, starting with the start folder and the skill listing.
8. **Cost by role** (`Impl`, `Review` and the `Final review` line). Compare the three. A reviewer that costs more than its implementer, or a final review that costs more than the tasks it checks, is a candidate for a cheaper model or a narrower brief.
