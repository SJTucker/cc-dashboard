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

The 2026-11-14 replay below measured it with `orch-reviewer`: $0.15 per Sonnet review
and $0.61 per Opus review, so Opus adds about $0.46 per review.

## Next step

Before switching, find out whether Sonnet reviewers miss things:

- read the run feedback files for problems found after a review passed;
- look for fix commits on a plan branch after a task's review passed.

If they do, run one orchestrate run with both reviewers on every task, Sonnet and Opus
side by side on the same claim, about $0.40 extra per task, and compare the findings.

Both checks are done (the search and the replay below). What remains is the live
side-by-side run, at about $0.61 extra per task for the Opus reviewer.

## Search, 2026-11-14

A search of 32 reviewed tasks across five runs found 3 confirmed misses and 2 probable
ones, all by Sonnet reviewers. None broke a path the owner uses.

## Replay, 2026-11-14

Four past tasks were reviewed again at their original tips by `orch-reviewer` on each
model, on the same claim. A and B hold problems found after their original review
passed. D and F had no later fixes, and serve as controls. A and B got 3 runs per model,
and D and F got 1. A Fable agent scored the 16 reports against the answer key without
knowing which model wrote which. One Opus review of A ran `git show main:SETUP.md`, so it
was voided and replaced. Its $0.67 is not in the averages below.

The rule was fixed before the run. A model catches an item when it does so in at least
2 of 3 runs. If Opus catches a counted item Sonnet does not, and reports no more than
one more false finding than Sonnet on the controls, the next step is the live
side-by-side run. Otherwise Sonnet stays.

| Item | Counted | Sonnet | Opus |
|---|---|---|---|
| A1: `SETUP.md` still says the mod forks once per idle gap | yes | 0 of 3 | 1 of 3 |
| B1: `claimsInTranscript` counts `api-request-blob` records as claims | yes (hard) | 0 of 3 | 0 of 3 |
| B2: `checkTask` does not validate `attempt` | yes (minor) | 0 of 3 | 3 of 3 |
| A2: `fireHandoff` calls `readyHandoff` with no guard (pre-existing) | no | 0 of 3 | 0 of 3 |
| B3: the `CLAIMED` match is anchored (plan-directed) | no | 0 of 3 | 0 of 3 |
| B4: `checkTask` accepts `files: []` (plan-directed) | no | 0 of 3 | 0 of 3 |

| | Sonnet (8 reviews) | Opus (8 reviews) |
|---|---|---|
| Answer-key catches | 0 | 4 |
| Other real findings that needed a fix commit | 0 | 7 (4 of them one-line comment or wrap fixes) |
| False findings | 0 | 0 |
| Wrongly said `SETUP.md` needed no change (A) | 1 of 3 | 2 of 3 |
| Average tokens per review | 217,536 | 589,925 |
| Average cost per review | $0.15 | $0.61 |

Per review. "Real" counts findings outside the answer key that held at the tip.
"Wrong clearance" is a report that said `SETUP.md` needed no change.

| Sample | Model | Key items caught | Real | Real, needed a fix | Wrong clearance | Tokens | Cost |
|---|---|---|---|---|---|---|---|
| A | Sonnet | none | 0 | 0 | 0 | 164,701 | $0.10 |
| A | Sonnet | none | 1 | 0 | 0 | 170,267 | $0.11 |
| A | Sonnet | none | 0 | 0 | 1 | 173,133 | $0.16 |
| A | Opus | A1 | 2 | 1 | 0 | 587,024 | $0.59 |
| A | Opus | none | 1 | 1 | 1 | 516,271 | $0.45 |
| A | Opus | none | 1 | 1 | 1 | 635,384 | $0.52 |
| B | Sonnet | none | 0 | 0 | 0 | 203,952 | $0.13 |
| B | Sonnet | none | 3 | 0 | 0 | 284,903 | $0.17 |
| B | Sonnet | none | 0 | 0 | 0 | 338,211 | $0.22 |
| B | Opus | B2 | 1 | 1 | 0 | 667,103 | $0.69 |
| B | Opus | B2 | 3 | 1 | 0 | 504,297 | $0.68 |
| B | Opus | B2 | 1 | 1 | 0 | 591,877 | $0.71 |
| D | Sonnet | n/a | 1 | 0 | 0 | 193,367 | $0.14 |
| D | Opus | n/a | 2 | 1 | 0 | 643,595 | $0.65 |
| F | Sonnet | n/a | 0 | 0 | 0 | 211,750 | $0.17 |
| F | Opus | n/a | 1 | 0 | 0 | 573,850 | $0.61 |

- All 8 Sonnet reviews passed with nothing that needed a fix. The Opus reviews also found a stale comment above `startHandoff` (A, 3 of 3), an empty `implementer.transcript` that `--add` accepts (B), a test that would pass without the CLI setting `attempt` (B), and an unwrapped 104-character line (D).
- Opus cost about 4 times as much as Sonnet per review, not 2 times. Its transcripts held about 2.4 times as many assistant records, and it used 2.7 times the tokens. Its price per token is twice Sonnet's, but most of its extra tokens were cache reads (2.9 times Sonnet's), which cost a tenth of input. Its cache writes, which cost most, were only 1.5 times Sonnet's.
- A's original reviewer used the subagent-driven-development prompt with a diff file and no transcript, unlike the replay.
- B1 needs knowledge the repo did not hold at the tip. No reviewer of either model caught it.

**Verdict: run the live side-by-side run.** Opus caught B2 in 3 of 3 runs and Sonnet in
0 of 3, with no false findings on the controls for either. Switching is decided after
that run.
