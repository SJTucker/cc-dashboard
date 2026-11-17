---
name: orch-plan
description: Use when the owner asks for an implementation plan with orch-plan, or types /orch-plan <spec path>, for work that the orchestrate skill will run. Writes a plan whose tasks carry the fields orchestrate needs.
---

# Writing Plans for Orchestrate

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the orch-plan skill to create the implementation plan."

**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` in the main checkout. The plan stays untracked: do not commit it, and never `git add -f` a path the repo ignores.

The owner starts the next steps. This skill does not start `/plan-review` or `orchestrate`.

## Start in the plan branch's worktree

Other work can merge into `main` while a plan is being written. The plan describes the commit its workers branch from, so read code from the plan branch's own worktree.

1. Read the spec's `**Plan branch:**` line: ``**Plan branch:** `<branch>`, worktree `<absolute path>` ``. An `orch-grill` spec has it.
2. When that branch has a worktree, reuse it, taking the path from `wt list --format json` and not from the spec's line, which can be stale.
3. When the branch exists with no worktree, run `wt switch <plan branch> --no-cd` without `--create`, then read its path from `wt list --format json`.
4. When the spec names no branch, or names one that does not exist, create it:
   - `git fetch origin`.
   - Pick the base the project's `CLAUDE.md` names for worktrees, else local `main`. Never pull into or reset local `main`, because another session may be working in the main checkout.
   - `wt switch --create <plan branch> --base <base> --no-cd`, then read the path from `wt list --format json`. Name the branch after the topic slug.

During the session:

- Every code read, every command and every Explore prompt names the worktree path. An Explore subagent searches the main checkout unless its prompt says otherwise.
- Run commands as `(cd <worktree> && …)` or `git -C <worktree> …`. Claude Code keeps a bare `cd` that ends inside the project, and `.worktrees/` is inside it.
- Save the plan in the main checkout's `docs/superpowers/plans/`. That folder is git-ignored, and a worktree's ignored files are deleted with the worktree.
- If the owner drops the plan, the worktree stays. The last message names `wt remove <plan branch>`.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans, one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure. If a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

No line-count limit applies to a task. `orchestrate` splits a task that raises `BUDGET`.

**Discovery gets its own task.** When a task must find something out by running it (a live probe, an engine behaviour nobody has checked), that finding becomes a task of its own, ahead of the task that uses it. Its report states the facts it found, and the later task consumes them as `behaviour`. A worker that probes and builds in one task spends its context on probes that fail, not on the build.

**Specs without the orch-grill sections.** A spec from the `brainstorming` skill has no Decisions or Edge cases section, and a repo may have no `GLOSSARY.md` or ADRs. Every rule below that reads one of those applies only when it exists. Write the plan without it otherwise.

**Edge cases into tests.** When the spec has an Edge cases list, each edge case gets a test in the task that owns the code, or a line in Review Focus saying why it has none. Review Focus still lists the five uncovered failure modes most likely to bite.

**Glossary and ADRs.** If `GLOSSARY.md` exists, new names in Interfaces blocks use its terms and avoid its `_Avoid_` words. A task whose work an ADR governs names the ADR in its `**Reads:**`.

## Step Granularity

**Each step is one action with a checkable result:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Written for orchestrate: Sonnet workers in parallel, each starting from a context image, this plan, and its own task. Also runs under subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements. The plan
argues from the spec, so the spec travels with it; executors read both]

## Global Constraints

[The spec's project-wide requirements (version floors, dependency limits,
naming and copy rules, platform requirements), one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section. Name the plan branch and its base here: orchestrate
section 5 reads them from this section.]

## Review Focus

[The five input classes or failure modes the spec implies but no task's
tests exercise that are most likely to bite a person using this software,
one line each, naming the input or condition and the behavior a
reasonable person would expect, most likely first. The spec is a vision
document: it says what the software must do, not everything it will
meet, and its silence on an input is not permission for that input to
break the program. Write the list here, once, with the spec in front of
you. Then, for each line, add the test that pins it to the task that
owns the code, in that task's own step style.]

## Dependencies

[One line per task: the tasks it consumes from, each marked `signature`
(its test can use a fake of the producer's Interfaces block, so it is
stub-ready) or `behaviour` (it must wait for the merge), and the files it
changes. Below that, a list of every file that two or more tasks change,
with those tasks. Two tasks that share a code file must have a dependency
between them, so they never run at once. A Markdown file (docs, `SETUP.md`,
a README, skill text) or other prose-only file is listed but needs no
dependency: tasks that share only such files run in parallel, and the
orchestrator resolves the conflict at merge.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks: exact signatures]
- Consumes (existing code): [exact signatures of existing functions the
  task calls or changes, with argument types where the code does not make
  them obvious]
- Produces: [what later tasks rely on: exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

**Test command:** [the exact command and which suite it runs]
**Fails before, passes after:** [the concrete test, and the failure it shows before the change]
**Done when:** [one narrow check, as a command and its expected result]
**Report:** [which outputs the worker pastes verbatim]
**Reviewer:** [opus or sonnet, with a one-line reason]
**Reads:** [existing files the worker needs beyond Files, each with one line on why]
**User steps:** [any step that needs the owner, or "none"]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Implement `function(input: InputType) -> ResultType` in `exact/path/to/file.py`**

One line on the approach when the signature and the test leave a choice
(which library call, which data structure); a code block only for an
algorithm they do not determine.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

Each labelled field is a bold label on its own line, written exactly as the fence shows, so `orchestrate` can find it. The `Field labels:` line below is the master list, and `skills/orchestrate/SKILL.md` names the same labels.

Field labels: `**Test command:**`, `**Fails before, passes after:**`, `**Done when:**`, `**Report:**`, `**Reviewer:**`, `**Reads:**`, `**User steps:**`

- **Test command:** the exact command and which suite it runs. Check it by reading the package.json script or Makefile target it calls, not by trusting its name.
- **Fails before, passes after:** the concrete test, and the failure it shows before the change.
- **Done when:** one narrow check, as a command and its expected result. `orchestrate` uses it as the claim's `doneWhen`.
- **Report:** which outputs the worker pastes verbatim.
- **Reviewer:** `opus` or `sonnet` with a one-line reason, chosen by the rule below.
- **Reads:** existing files the worker needs beyond its own Files, each with one line on why (a test helper and its limits, the stylesheet and token names, the caller of a changed function). The worker opens them after it claims the task.
- **User steps:** any step that needs the owner (a decision, a manual check, a live check that needs a permission auto mode does not give). Each says what is needed and why. `orchestrate` does these before dispatch.

Steps after the last task that no worker does, such as final checks or the merge, go under a `## ` heading. A `### ` heading other than `### Task N:` stays in the task above it, so it reaches that task's worker.

The `**Reviewer:**` rule, copied from `orchestrate` section 5, item 4. Choose `opus` when the task touches concurrency,
locking or claim code; adds or changes a model call, a network request or money
math; changes behaviour that a project rule ties to another file (a CLAUDE.md
"in the same change" rule); or is expected to change more than 300 lines of
code outside Markdown. Choose `sonnet` otherwise.

## What a Step Contains

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: unambiguous, not complete. Each kind
of step carries what makes it unambiguous and nothing more:

- **A test step:** the test's name and its assertions, as code, with the
  spec's exact values in them.
- **A code step:** the exact signature (name, parameters, return type), the
  file it lives in, and the specific values the spec pins. The implementer
  writes the body. A body appears only for an algorithm the signature and
  tests do not determine, or for exact copy the spec fixes.
- **A verification step:** the command to run and the output that means it
  passed.
- **A reference to another task:** that task's Interfaces block says what
  to use; the plan does not repeat that task's code.

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead. Lines that
decide nothing ("TBD", "handle edge cases", "add appropriate validation",
"write tests for the above", a type or function no task defines) are the
opposite failure, and the self-review catches both.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself, not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Step scan:** Every step must let the implementer write exactly one reasonable thing, and no step may carry more than that: a line that decides nothing is a gap, a function body the signature and tests already determine is a transcript. Fix both.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each input class or failure mode the spec implies, is there a task whose tests exercise it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each line there gets its test added to the owning task. An empty section means you checked and found none, not that you skipped the check.

**5. Proportion:** Compare the plan's length to the spec's. A plan several times longer than the spec it implements is a transcript of the program, not a plan. If code blocks are most of the document, replace bodies with signatures, test names and assertions, and check that each step is still unambiguous.

**6. Dependencies:** Every Consumes names a Produces of an earlier task or existing code. Every code file that two or more tasks change has a dependency between those tasks. A Markdown or other prose-only file shared by tasks needs no dependency.

**7. Test commands:** Each task's test command was checked against the script or target it calls.

**8. Reads:** For each task, would a worker need to open a file that is in neither Files nor Reads to write the code? Add it.

**9. Discovery:** No task both finds out how something behaves by running it and builds on what it finds.

If you find issues, fix them inline. No need to re-review. Just fix and move on. If you find a spec requirement with no task, add the task.

## Handoff

After saving and self-reviewing the plan, say: "Plan saved to `<path>`. Please review it." Then add one line naming the steps the owner starts next: `/plan-review <path>`, then `orchestrate`. Offer no execution menu. If the plan branch's worktree was created for this plan, name `wt remove <plan branch>` for the case where the owner drops the plan.
