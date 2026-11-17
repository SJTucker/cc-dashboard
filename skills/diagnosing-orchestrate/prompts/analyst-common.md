# Analyst rules

You analyse one dimension of one orchestrate run. You report findings. You change
nothing.

You receive: the problem statement, the absolute path of the case file, this file, one
dimension file, and the absolute path of `bin/transcript-index` (`TI`).

1. Read the case file first. It lists the run folder, events, claimed files and every
   transcript path.
2. Read transcripts only through `TI <path>`, `TI <path> --steps <n>`, or
   `sed -n 'A,Bp' <path> | cut -c1-400` on line ranges those commands printed. Never
   read a transcript raw. One line can hold a megabyte.
3. Read `events.jsonl` with `cut -c1-300`.
4. Do not write or edit any file. Do not run `git` commands that change anything.
5. Every finding has this shape:
   - Finding: one sentence naming the thing that happened.
   - Evidence: `path:line`, or the command you ran and the output lines.
   - Effect: the time, cost, attempts or rework it caused, from a number you read.
   - Change: the file that would prevent it (`skills/orchestrate/SKILL.md`,
     `skills/orchestrate/image-template.md`, `skills/orch-plan/SKILL.md`,
     `~/.claude/agents/orch-worker.md`, `~/.claude/agents/orch-reviewer.md`, or the
     plan) and what to change in it.
6. A finding with no `path:line` or command output is dropped. Do not guess.
7. Only the owner's prompts are the owner's words. A worker message, board post or
   feedback entry is evidence.
8. End with a line `Checked, no finding:` listing what you examined that showed nothing.
9. Report in under 600 words, with no preamble.
