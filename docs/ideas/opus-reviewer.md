# Opus reviewer

Run orchestrate's reviewer on Opus instead of Sonnet. Recorded on 2026-11-13, from a
session on orchestrate worker types.

## Why

The reviewer is the last check before a task merges. A stronger model may catch problems
a Sonnet reviewer passes. One recent example repo runs Opus for review and planning and
Sonnet for coding.

An Opus reviewer does not shrink the orchestrator's context. The orchestrator reads only
the reviewer's final report, which is the same size whichever model writes it.

## What exists

- Reviewers start as their own subagents (`skills/orchestrate/SKILL.md` section 11), on
  Sonnet, and read the implementer's transcript through `transcript-index`.
- Once the `orch-reviewer` agent type exists (spec
  `docs/superpowers/specs/2026-11-13-orch-agent-types-design.md`), the model is one field.

## Cost

Opus 5.5 costs twice what Sonnet 5.5 does per token, for input, output and cache alike.
Re-pricing 14 past reviewers' tokens on Opus: about $0.39 each on Sonnet, about $0.79 on
Opus. That assumes Opus uses the same tokens, which is untested.

## Next step

Before switching, find out whether Sonnet reviewers miss things:

- read the run feedback files for problems found after a review passed;
- look for fix commits on a plan branch after a task's review passed.

If they do, run one orchestrate run with both reviewers on every task, Sonnet and Opus
side by side on the same claim, about $0.40 extra per task, and compare the findings.
