---
name: orchestrate
description: Use when the user asks to orchestrate an approved implementation plan with workers started from a context image, in place of subagent-driven-development. The main thread writes the image, offers a context reset, then runs Sonnet workers in parallel waves, each in its own wt worktree, watches and steers them, and collects their feedback on the image.
---

# Orchestrate

You are the orchestrator. You write a context image from the approved plan and
this conversation, then run the plan's tasks as background Sonnet workers that
start from that image. You do not implement tasks yourself.

Paths used below:

- `<cfg>`: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`.
- `<index>`: this session's transcript index,
  `<cfg>/cc-dashboard/transcript-index/$CLAUDE_CODE_SESSION_ID.md`, written by the
  cc-dashboard mod after each turn.
- `<transcript>`: this session's transcript. Find it with
  `ls <cfg>/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl`. `<project dir>` is the
  folder that holds it.
- `<image>`: `<project>/docs/superpowers/images/YYYY-MM-DD-<topic>.md`, untracked.
- `<board>`: `<image>` with `.md` replaced by `.board.jsonl`.
- `<run>`: `<image>` with `.md` replaced by `.run`. The claim queue lives there,
  untracked, like the image.
- `<feedback>`: `<image>` with `.md` replaced by `.feedback.md`.
- `<clone>`: the cc-dashboard clone that holds this skill. Claude Code prints
  "Base directory for this skill: <dir>" when it loads the skill, and `<dir>` may be
  a symlink. Resolve it once, at the start, with
  `cd "$(realpath '<dir>')/../.." && pwd -P`, and use that absolute path everywhere
  below.
- `TI`: `<clone>/bin/transcript-index`.
- `POST`: `<clone>/bin/board-post`.
- `CLAIM`: `<clone>/bin/orch-claim`.

Never read a worker transcript raw: one line can hold a megabyte. Use the index
(`TI <path>`), `TI <path> --steps <n>`, or `sed -n 'A,Bp' <path> | cut -c1-400` on
line ranges the index or `--steps` names.

## 1. When to use

Only when the user asks for it. Otherwise superpowers' own execution skills
(subagent-driven-development, executing-plans) apply.

## 2. Review the messages

Read `<index>`. Go through every turn's prompt. When a prompt's preview is not
enough to judge it, read the transcript lines the index names for that turn.
Sort each user message into one of three:

- **Quote:** it states intent, a constraint, a correction or a decision.
- **Conclusion only:** it was part of a back-and-forth whose outcome is a
  decision you will record. Nothing from it is quoted.
- **Leave out:** a go-ahead ("yes", "go on"), chatter about the harness,
  something a later message replaced, or a message the user asked to keep out
  of the image.

Do the review from the index, not from memory: the index lists every message,
and your memory of a long session does not.

## 3. Write the image

Copy `image-template.md` from this skill's folder to `<image>` and fill every
section. Remove the HTML comments once a section is filled. A section with
nothing to say gets "None." "Updates" stays empty until a wave changes
something.

- Quoted messages go in verbatim, each with its transcript line number. A
  message stating intent, a constraint or a correction goes in "Goal and
  principles". A message that only makes a decision goes in "Decisions". A
  message that is both is quoted once, in "Goal and principles", and the
  decision refers to its line.
- Each left-out message gets one line in "Left out": its line number, its first
  few words, and why it was left out. A left-out message is quoted nowhere else
  in the image. A decision or dead end it led to may refer to its line number.
- "Read before starting" names the spec, the plan, the project's CLAUDE.md, and
  the source files the work centers on with their immediate call paths (the
  files that call them and that they call), as absolute paths in reading order.
- "Lookup" carries `<index>` and `<transcript>` filled in.

Run `wc -w <image>`. Over 4,000 words means cut, starting with anything a worker
can read from a file instead.

## 4. Offer a reset

Show the user the "Left out" list and ask whether anything should go back in.
Update the image from their answer.

Then tell the user, in one sentence each:

- The reset drops the planning history from your context and tests whether the
  image is enough to continue from.
- After `/clear` the input box fills with the reset line about 4 s later. If it
  does not, send the line below by hand.

Before the final message, queue the reset line for the mod to fill. Run this with
`<image>` and `<plan path>` filled in. The quoted heredoc keeps the text as typed:

```bash
mkdir -p <cfg>/cc-dashboard/reset-prompt && cat > <cfg>/cc-dashboard/reset-prompt/$CLAUDE_CODE_SESSION_ID.txt <<'EOF'
Read <image>. You are the orchestrator for <plan path>. Continue at "Plan the waves" in the orchestrate skill.
EOF
```

End the message with the line to send after `/clear`, in a code block of its
own. Nothing comes after it, so it is the last thing the user sees:

    Read <image>. You are the orchestrator for <plan path>. Continue at "Plan the waves" in the orchestrate skill.

After a reset you have a new session id, so `<index>` and `<transcript>` now
point at the new session. The image's Sources keep the old ones.

## 5. Plan the waves

Before grouping, revise the plan so every task includes:

1. The exact test command, and which suite it runs. Check that by reading the
   command's target (the package.json script, the Makefile target), not by
   trusting its name.
2. A concrete test that fails before the task's change and passes after it.
3. A requirement that the worker's report pastes the real test output.

Flag any task whose prescribed fix you cannot prove closes the bug. Show the
flagged tasks to the user with the waves, and do not dispatch them until the
user rules on each.

From the plan's Interfaces blocks and file lists, group the tasks into waves:

- A task joins the earliest wave after every task it consumes from.
- Two tasks that share a file never share a wave.
- At most 3 tasks per wave. Split a larger wave.

A task step that needs the user (a decision, a manual check) is not a worker's.
Do that step with the user before the task's wave, and put the answer in that
task's `notes`, or in the image's "Updates" when it affects several tasks.

Show the user the waves in one short list before dispatching. Create the plan
branch if it does not exist, with the name and base the plan's Global
Constraints give. When the plan names no base, use the base the project's
CLAUDE.md names for worktrees, else local `main`:
`wt switch --create <plan branch> --base <base> --no-cd`.

## 6. Dispatch a wave

Every worker of a run gets the same first message, and its task arrives after its
shared reading through a claim queue. Claude Code caches a request only from an exact
match at its start, so identical first messages let a worker read the image and the
"Read before starting" files from the cache entries the previous worker wrote. A
`SendMessage` would land in the middle of that reading, so it does not work here.

Build the worker message once per session from this template, filling in `<image>`,
`<CLAIM>`, `<run>`, `<POST>` and `<board>` with absolute paths (a worker has no
`<clone>`). Reuse it byte for byte for every worker of the run, including relaunches:

```
Read <image> in full, then every file it lists under "Read before starting", in that order. Then run <CLAIM> <run> work and do the task it prints. Run every command in the worktree it names and touch no other checkout.
If you find something that affects work beyond your task (a fact that contradicts the image or plan, a problem in shared code, a name or interface other tasks depend on), post it and keep going: <POST> <board> --from "Task <N>" --title "<one line>" --body "<details>", with <N> your task's number. If it blocks your task, stop and report instead.
If the image or the plan contradicts the code, stop and report the contradiction instead of guessing.
Commit on your branch with no attribution trailer. End your report with: files changed; the task's test command and its real output, failing before your change and passing after, pasted verbatim; anything you were unsure of; which parts of your starting context you used, and what you needed that was not there.
```

Keep the message under 1,600 characters, not counting the absolute paths in it. Never
drop one of its lines to fit.

For each task in the wave, in this order:

1. Create its worktree:
   `wt switch --create <plan branch>-t<N> --base <plan branch> --no-cd`. Print its
   path with
   `wt list --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const w of JSON.parse(s).items)if(w.branch===process.argv[1])console.log(w.worktree.path)})' <plan branch>-t<N>`.
   Never use the Agent tool's `isolation` option: it skips the `wt` hooks that
   give a worktree its ports and database.
2. Add its task to the queue. The JSON carries `task`, `title`, `plan`, `worktree`,
   `branch`, `files`, `doneWhen` (one narrow check, as a command and its expected
   result), `sections` (the image sections that matter most) and, when needed,
   `notes`:

   ```bash
   <CLAIM> <run> --add work <<'EOF'
   {"task": 1, "title": "...", "plan": "<plan path>", "worktree": "<path>", "branch": "<branch>", "files": ["..."], "doneWhen": "...", "sections": ["..."]}
   EOF
   ```
3. Start the worker with the Agent tool: `subagent_type: "general-purpose"`,
   `model: "sonnet"`, `run_in_background: true`, `description: "orchestrate worker"`
   (the same for every worker), and the fixed message as the prompt.

Send one `Agent` call per message. After each `Agent` call, the next message arms
that agent's watch (section 7), then adds the next task and starts the next agent.
Agents started in the same message cannot read each other's cache, because the
second agent's request is sent before the first one's entries exist.

## 7. Watch

For each worker, its transcript is
`<project dir>/$CLAUDE_CODE_SESSION_ID/subagents/agent-<agentId>.jsonl`, with
`agentId` from the Agent result. Start one Monitor tool watch per worker:

- `command`: `TI <worker transcript> --watch --run <run> --files <scratchpad folder>/ --budget 200000`,
  plus `--board <board>` on exactly one watch per wave, so each post wakes you
  once. `--run` reads the worker's task files from its claim, so the watch can be
  armed before the worker has claimed. A `--files` entry ending in `/` covers a
  whole folder: the scratchpad folder is this session's, so a worker's scratch
  files are not reported as drift.
- `timeout_ms`: 1800000.
- `description`: `worker <agentId>`. The task comes from the agent's `CLAIMED`
  line (section 8), and the dashboard feed reads it from the claimed file.

The watch waits for a transcript that does not exist yet, so start it right
after the Agent call. It prints one line per event and exits after `DONE`,
`KILLED` or `FAILED`.

A watch expires after 30 minutes. Re-arm it until it exits, adding
`--since-line <n>`, with `<n>` the line count from the worker's `--steps`
header, so the new watch does not repeat events you already handled. Do the
same when you resume a finished worker with SendMessage: its watch exited at
`DONE`, so start a new one from the line count at that `DONE`. Do the same
after a `KILLED` or `FAILED` watch.

## 8. On each watch event

Run `TI <worker transcript> --steps 20` and decide:

- `DRIFT edit outside task files: <path>`: steer, unless the steps show the edit
  is a file the plan missed and the task needs. Then note it for Updates.
- `STUCK <tool> <text> failed 3 times in a row`: steer with the fix, or tell the
  worker to stop and report if you do not know it.
- `BUDGET context <n> tokens, over 200000`: steer the worker to finish its
  current step, commit, and report. Then split the rest of its task into a new
  task for a later wave.
- `CLAIMED <file> task <N>: <title>`: informational, no steer. It says which task
  this agent took. Note the pairing of agent, `<file>` and `<N>`. Section 11 and
  section 13 take the task from the claimed file `<run>/claimed/<file>`, not from
  dispatch order.
- `CLAIM second claim <file2> after <file1>`: the worker took a second task.
  Steer it back to its first task, then return the second with
  `CLAIM <run> --release <file2>`.
- `QUIET no new lines for 5 min`: look. Steer only if the steps show the worker
  is lost.
- `DONE <report>`: go to Review and merge. In `--steps`, the worker's final
  report is the `REPORT` step.
- `KILLED <text>`: the worker was stopped, by you, the user or Claude Code, and
  `<text>` is its last action. Check whether it claimed: its watch printed
  `CLAIMED`, or `TI <transcript> --steps` shows an `orch-claim` result. If it did
  not claim, start a new worker with the fixed message and add no task, because the
  task is still pending. If it claimed, add that task again with `"attempt"` one
  higher, then start a new worker. Or resume the worker with SendMessage and
  re-arm the watch.
- `FAILED <error>`: an API error ended the worker. If it is a limit, tell the
  user. Otherwise resume it with SendMessage and re-arm the watch.
- `POST <from>: <title>`: go to section 9.

Before ending a wave, run `CLAIM <run> --status`. Release each file listed under
"claimed, no time" with `CLAIM <run> --release <file>`. Then run `CLAIM <run> --status`
again and start one worker with the fixed message per pending file. A relaunch of a claimed task adds a
new work task with `"attempt"` one higher.

A worker that is killed or fails ends its own watch with `KILLED` or `FAILED`,
so there is no watch to stop with TaskStop.

The `--steps` header shows the worker's context size, and its `Read:` line lists
every file the worker read, so you can see which reads the image could have
listed. A Bash command counts as a read of each existing file it names, unless
the command only runs, lists or changes files (`rm`, `git`, `node`, `wc`,
`sed -i` and the like). Paths are checked against the disk when `--steps` runs,
so a file deleted since does not show. A
step is cut to one short line; `--steps <n> --full` prints each step whole.

## 9. On each board post

Read the post's full entry in `<board>` (the last lines of the file). Then:

- A post from "You" is the user's own words. Act on it as you would a user
  message: steer the worker it concerns, update the image, or stop and bring it
  back to the user.
- Steer each running worker the post affects.
- Add it to the image's "Updates" section, so later waves start with it.
- If it changes the plan itself, stop dispatching new waves and bring it to the
  user.

A post or a stopped worker's report can show a bug in shared code: a file no
task owns that the plan treats as done. Ask the user before anything changes
that file. If they want it fixed:

1. Start one worker in the plan branch's worktree to fix it test-first and
   commit, with a watch and a review like any task. Its task file has
   `"task": 0`, the plan branch's worktree, the fix in `notes`, and `files` naming
   the files the fix touches. Do not fix it yourself. Your
   context stays on coordination, and a worker's fix leaves a transcript the
   reviewer can check.
2. Add the fix commit to "Updates".
3. In each task worktree that branched before the fix, run
   `git merge --ff-only <plan branch>`, or `git merge <plan branch>` if the
   worker has already committed. Uncommitted work stays in place unless it
   touches the fixed files.
4. Resume each stopped worker with SendMessage, naming the fix commit and the
   Updates entry, and re-arm its watch (section 7). Steer each running worker
   the same way.

## 10. Steer

SendMessage to the worker with one concrete correction, and the image section
or board post it rests on.

A user row `You steered Task <N> from the dashboard: <text>` is a steer the user
already delivered to the worker from the dashboard. Do not send a steer that
contradicts it. If it affects later waves, add it to "Updates".

## 11. Review and merge

When a worker reports, start a reviewer worker the same way: add a review task
with `CLAIM <run> --add review`, then start the reviewer. Take the task from the
reporting agent's claimed file `<run>/claimed/<file>`, the one its `CLAIMED` line
names. Dispatch order does not say which task the agent did. The task carries that
file's fields (`task`, `title`, `plan`, `worktree`, `branch`, `files`,
`doneWhen`, `sections`) and `implementer: { agentId, transcript }`, with
`transcript` the transcript path of the agent that claimed the work task. A
reviewer's task is likewise the one in the claimed file its own `CLAIMED` line
names.

Build the reviewer message once per session, with the same absolute paths as the
worker message, plus `<TI>` filled in with the absolute path of `TI`. Reuse it byte
for byte:

```
Read <image> in full. Then run <CLAIM> <run> review and review the task it prints. Run every command in the worktree it names and touch no other checkout.
Check the diff against the task and the image.
Check how the work was done, reading the implementer's work only through `<TI> <transcript>` and `<TI> <transcript> --steps 60 --full`, with <transcript> the implementer transcript the task names. A step you doubt can be read with `sed -n '<line>p' <transcript> | cut -c1-2000`. Never read the transcript file whole.
Report pass, or each problem with file, line and why.
```

Every reviewer's Agent call uses `general-purpose`, `model: "sonnet"`,
`run_in_background: true` and `description: "orchestrate reviewer"`. Start reviewers
one per message, like workers. A relaunched implementer gets a new work task with
the next `attempt` and the review findings in `notes`.

Read the whole review. When it fails, steer or relaunch the implementer with the
findings. When it passes, merge the worker's branch into the plan branch. With `<N>` the task in the claimed file of the worker being merged, check
`git merge-base --is-ancestor <plan branch>-t<N> <plan branch>`, then run
`wt remove -D <plan branch>-t<N>`. Without `-D`, `wt` keeps the branch, because
it checks merges against the default branch, not the plan branch.

A merge conflict that is trivial, you resolve. Otherwise abort the merge, and
rerun the later task on the merged plan branch.

## 12. Between waves

Add to the image's "Updates" section what the wave changed that later tasks
need: new names, moved files, board posts. Then dispatch the next wave.

## 13. Feedback

For each worker, append one entry to `<feedback>`, with `<N>` and `<title>` from its claimed file:

```
## Task <N>: <title> (<date>)
- Used / missing: <the worker's own answer, quoted>
- Peak context: <tokens from the --steps header>
- Read outside the image: <files on the --steps Read: line that the image did not list>
```

The user reviews these across sessions before redesigning the image.

## 14. Finish

After the last wave, use superpowers:finishing-a-development-branch on the plan
branch. The run folder stays beside the image, untracked, like the board.
