# Orchestrate workers share one prompt prefix

Status: accepted (2026-11-11, extended 2026-11-14)

Every orchestrate worker and reviewer begins by reading the same files: the context image and the files it lists under "Read before starting". A Sonnet request reads the prompt cache only on an exact match from the start of the request. So the orchestrate skill sends every agent of a run the same request start, and the task-specific part arrives later. A worker started within the 5-minute cache window of a sibling then reads that shared reading from the sibling's cache entries instead of writing its own.

## Decision

- **One fixed first message per role.** Every worker of a run gets the same first message, byte for byte, and so does every reviewer. The orchestrator builds each message once per session from the template in `skills/orchestrate/SKILL.md` (sections 6 and 11) and reuses it, relaunches included. The Agent call's `description` is fixed too: `orchestrate worker` or `orchestrate reviewer`.
- **The task arrives through a claim queue.** The first message ends by running `bin/orch-claim <run> work` (or `review`), which takes the oldest task file from `<run>/pending/<kind>/` and prints it. The task is the last tool result after the shared reading, so everything before it matches across siblings.
- **Fixed agent types.** Workers start as `orch-worker` and reviewers as `orch-reviewer` (`agents/`). Each has a short system prompt with no run- or task-specific text and a fixed tool list.
- **One Agent call per orchestrator message, always from the project root.** The next message arms that agent's watch, then queues the next task and starts the next agent.

## What must match

Two agents of one type share a cache entry only when all of these are identical at the start of their requests:

- the system prompt, which includes the agent file, the skill listing, the CLAUDE.md files and the git status of the start folder;
- the tool list;
- the start folder, which is the folder the orchestrator's shell is in at the Agent call;
- the first message;
- the files read before the claim: the image and its "Read before starting" list, in the same order with the same content.

So, during a run:

- The image's "Read before starting" lists only files every worker needs. A task's own extra reading comes after its claim.
- The plan and the image do not change between dispatches in a wave. Changes after the first dispatch go in a task's `notes` or the image's "Updates", added between waves.
- Nothing links, unlinks or changes the `description` of a skill or agent in `<cfg>` mid-run, because the skill listing is part of the system prompt.
- The main checkout's git status stays fixed. Files a planning session wrote get committed before the run starts.

## Evidence

- A follower started 2.8 s after its leader, with the same first message and the same image and four files, wrote 0 tokens and read every step from the leader's entries. The leader wrote 58,511 (2026-11-11).
- Two agents started 0.17 s apart shared nothing and both wrote the full 18.9k. A follower needs its leader's entries to exist first, which is why there is one Agent call per message.
- A `general-purpose` subagent's first request carried about 39k tokens before the task. An `orch-worker` carried 13.0k for the same first message, with siblings reading all of it from cache (Claude Code 2.1.323, 2026-11-13).
- Across 12 runs, Agent calls made from a folder other than the project root caused 9 of 47 cache misses.
- On Sonnet 5.5 a 5-minute cache write costs $2.50/MTok and a read $0.10/MTok.

`bin/skill-cost` re-measures run cost. A follower within a wave should write close to 0 tokens through its shared reading.

## Considered options

- **Per-task first messages** (the earlier design: "Your worktree is …" on line 1). Nothing after the system prompt and tool list was shared.
- **Sending the task with `SendMessage`.** A message lands at the agent's next tool round, which falls during the shared reading, so the conversation diverges from that point.
- **A "reply ready, then wait" step.** Each "ready" wakes the orchestrator, and each orchestrator turn re-reads 160k–250k tokens, which cancels the saving.
- **Looking up the task by agent id.** A subagent has no environment variable naming its own agent id.
- **1-hour cache writes** (`experimental.cacheTtl`). They double the price of every write. The estimate was several times the cost of the 19 expiry misses they would have saved across 12 runs.
- **Keeping `general-purpose` and restricting tools through the mod.** The mod could refuse calls but could not shrink the 39k prefix.

## Consequences

- The Orchestration tab and `TI --watch` cannot read a worker's task from its prompt. They read it from the claimed task file the worker's `orch-claim` result names.
- Sharing does not cross waves. The 5-minute window and the "Updates" edits between waves both rule it out.
- Sharing depends on siblings making the same tool calls through the shared reading. If they diverge, each pays what it would have paid without sharing.
