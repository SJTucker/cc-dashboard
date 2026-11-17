# Finding the sessions of a run

Everything starts from `<image>`.

1. **Orchestrator transcript.** The `Orchestrator transcript:` line under "Sources" in the
   image. If the file is gone, search with
   `ls <cfg>/projects/*/<session id>.jsonl`. `<cfg>` is
   `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`. Its project dir is the folder that holds it.
2. **Worker and reviewer transcripts.** They sit at
   `<project dir>/<orchestrator session id>/subagents/agent-<agent id>.jsonl`, with
   `agent-<agent id>.meta.json` beside each. `bin/transcript-index` prints that path for
   every agent the orchestrator started, in `TI <orchestrator transcript>`.
3. **Which agent did which task.** Three sources agree, and you should check at least two:
   - `<run>/events.jsonl`: a `claimed` event names the agent and the claimed file.
   - The agent's transcript: its `orch-claim` result starts with `CLAIMED <file>`, and its
     third line names the task: `Task <N> of <plan>` (`Review Task <N>` for a reviewer).
     `TI <transcript> --steps 5` shows it near the start.
   - `<run>/claimed/<file>.json`: the task's fields. A review file carries
     `implementer: { agentId, transcript }`, which names the worker it reviews.
   Dispatch order does not say which task an agent did. Use the claimed file.
4. **The final review** and every agent it started: the `final-review` event names the
   agent, and `parentAgentId` in the `agent-*.meta.json` files links the others to it.
   `REPORT <image>` already resolves this, so prefer its agent rows.
5. **Retries.** A task's later attempts are separate claimed files (`<seq>-t<N>-a<attempt>.json`)
   with the earlier attempt's `notes`. Read the `notes` of each before the transcript.

Record each path in the case file. A path that does not exist is listed as missing, with
the reason if you know it.
