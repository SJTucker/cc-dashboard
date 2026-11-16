# Questions panel

Show the questions an orchestrate run is waiting on in the Orchestration tab, and let
the owner answer them there. Raised on 2026-11-13 in a session on orchestrate worker
types.

## Why

When the orchestrator asks something mid-run, the question usually sits in the terminal
until the owner notices it, and the tasks it concerns stay paused (owner, 2026-11-14).
A list of open questions alone would not fix that. The panel has to take answers too.

## What exists

- **Board composer.** The Orchestration tab can post to the run's board as "You", and
  the orchestrator treats a "You" post as the owner's own words. A post wakes the
  orchestrator only when one of its watches carries `--board`. Otherwise the post waits
  in the board file.
- **"Waiting for you".** The "Now" box shows this when the orchestrator is idle, with
  its last message cut to 140 characters. Nothing there records which question is open
  or which task it belongs to.
- **Waiting events.** Section 5 of `skills/orchestrate/SKILL.md` logs
  `EVENT <run> waiting --task <N> --text "<question>"` when a question goes out and
  `EVENT <run> answered --task <N>` when the answer arrives. Those events name the task
  and hold the question text, so the panel can list open questions from `events.jsonl`.
- **`$.prompt.submit`.** The mod can start a turn in an idle session as if the owner
  had typed it. The mod does not use it yet. An answer sent through it would reach the
  orchestrator without depending on a `--board` watch.

## Open

- Whether an answer goes in as a board post, through `$.prompt.submit`, or both.
- How the panel shows a question that covers several tasks.
- Whether to notify the owner when a new question opens.
