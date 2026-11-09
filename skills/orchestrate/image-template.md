# Context image: <topic>

<!-- Written by the orchestrator from an approved plan, under
docs/superpowers/images/YYYY-MM-DD-<topic>.md, untracked. Every worker reads this
file in full before its task. Keep it under 4,000 words, not counting the files it
points to: cut anything a worker can read from a file instead. -->

## Sources

<!-- Absolute paths: the spec, the plan, the orchestrator's transcript and its
index, the board file and the feedback log. -->

- Spec:
- Plan:
- Orchestrator transcript:
- Transcript index:
- Board:
- Feedback log:

## Goal and principles

<!-- The user's own messages that state intent, constraints or corrections, quoted
verbatim, each with its transcript line number: `> text` then `(line N)`. Which
messages go here comes from the message review. -->

## Read before starting

<!-- An ordered list of files every worker reads in full, each with one line on
why: the spec, the plan, the project's CLAUDE.md, then the source files the work
centers on and their immediate call paths. Absolute paths. -->

1.

## Decisions

<!-- Each decision, the alternatives rejected, and the transcript line range where
it was made. Quote the user's message verbatim when it only makes the decision.
When that message is already quoted in Goal and principles, refer to its line. -->

## Dead ends

<!-- What was tried and failed, and why, so no worker tries it again. "None." if
nothing was. -->

## Orientation

<!-- Where things live, naming conventions, and the exact commands that check the
work: test commands, lint, type checks, with how to run them in a worktree. -->

## Environment

<!-- The plan branch and its worktree path, ports, databases, and the rule that
each worker runs every command in its own worktree. -->

## Worker protocol

<!-- What every worker does besides its task. Keep these four points, edited to the
project. Replace <POST> with the absolute path of bin/board-post. -->

- **Stop and ask:** if the image or the plan contradicts the code, stop and report the contradiction instead of guessing.
- **Board:** a discovery that affects work beyond your task (a fact that contradicts this image or the plan, a problem in shared code, a name or interface other tasks depend on) goes on the board with `<POST> <board path> --from "Task <N>" --title "<one line>" --body "<details>"`. Then keep going, unless it blocks your task. No progress updates.
- **Tests first:** write each new test and run it in a Bash call of its own, and see it fail, before you write the code it tests.
- **Commits:** commit on your branch, with no `Co-Authored-By` or other attribution trailer.
- **Report:** end with the files changed; the check you ran and its result; anything you were unsure of; which parts of your starting context you used, and what you needed that was not there.

## Updates

<!-- Facts that changed after this image was written: board posts and what earlier
waves changed that later tasks need (new names, moved files). The orchestrator adds
to this between waves. Starts empty. -->

## Left out

<!-- One line per user message the review dropped: its transcript line number, its
first few words, and why it was left out. A worker can read any of them with the
Lookup commands. -->

## Lookup

<!-- For anything not in this image, search the orchestrator's transcript through
its index. Fill in both paths. -->

The transcript index lists each turn of the orchestrator's session with the transcript lines it covers: `<index path>`.

Never read the transcript whole: one line can hold a huge tool result. Print a range with each line cut to 400 characters:

    sed -n 'A,Bp' '<transcript path>' | cut -c1-400

Find one record by the uuid in a turn heading:

    grep -n '"uuid":"<uuid>"' '<transcript path>'

Find where a word came up:

    grep -n '<word>' '<transcript path>' | cut -c1-200
