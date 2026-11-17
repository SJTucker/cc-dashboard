# Diagnosis: <topic>

Run: <image absolute path>
Case file: <run>/diagnosis-case.md

## Problem statement

<run, expected, happened, measure>

## Verdict

<One paragraph: the cause or causes, ordered by how much of the measure each explains.
When no cause was found, say so and list what was checked.>

## Findings

### Cause 1: <name the mechanism>

- Evidence: `<path:line>` or `<command>` with the output lines that matter.
- Effect: <the number it moved, from REPORT, MISSES or events.jsonl>
- Verified: yes | unverified (<why>)
- Change: <file> — <what to add, remove or reword, in one or two sentences>

### Cause 2: ...

## Checked, no cause

<Dimensions or checklist items that were examined and showed nothing, one line each.>

## Proposed changes

| File | Change | Cause |
|---|---|---|
| skills/orchestrate/SKILL.md | | |
| skills/orchestrate/image-template.md | | |
| skills/orch-plan/SKILL.md | | |
| ~/.claude/agents/orch-worker.md | | |
| ~/.claude/agents/orch-reviewer.md | | |
| the plan | | |

Delete the rows with no change. An approved change goes through a normal cc-dashboard
branch.
