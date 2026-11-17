# Subagent task descriptions in transcripts.db

Asked for on 2026-11-17. `transcripts.db` stores every subagent transcript but not
the task the subagent was given. The idea is to record that task, so a subagent's
cost can be read next to what it was asked to do.

## What the db has today (checked 2026-11-17)

- There is no per-agent table. `lib/rowstore.js` reads every `*.jsonl` under
  `<cfg>/projects`, so each `<session>/subagents/agent-<id>.jsonl` gets its own
  `files` row keyed by path. The rows `lib/extract.js` builds for that file are
  stored as JSON in `files.data`.
- Call rows carry `agentId`, `sessionId` (the parent's) and `attributionAgent` (the
  agent type). Agent tool-use rows keep only `input.subagent_type` as `detail`
  (`toolDetail` in `lib/transcript-lines.js`). The description and prompt are
  dropped.
- `lib/extract.js` never reads `description` or `meta.json`. Other readers do, outside
  the db: `lib/transcript-index.js`, `lib/orchestrations/parse.js`,
  `lib/orchestrations/discover.js`, `bin/transcript-index` and `bin/orch-report`.
- Nothing in `public/` shows one agent at a time. The Subagents list in Where usage
  goes groups by agent type.

## Where the description comes from

- `agent-<id>.meta.json` sits next to each subagent transcript. It holds `agentType`,
  `description` (the Agent tool's short description, such as "Mockup via
  artifact-design"), `toolUseId`, `spawnDepth`, `pickedEffortModel` and, on some
  files, `model` and `parentAgentId`. On 2026-11-17 all 2,152 subagent transcripts
  on disk had a meta file, back to the oldest on 2026-10-06. 2,124 of them had a
  `description`. The 28 without one were not inspected. The one team agent sampled
  had no `toolUseId`.
- The prompt is not in `meta.json`. It is the first line of the subagent's own
  `agent-<id>.jsonl`, as a `user` message. All 465 sampled files whose parent
  recorded a prompt matched it on that first line. No join to the parent is needed.
- The parent session also has the prompt, in the Agent tool_use `input.prompt` and
  in `toolUseResult.prompt`, linked by `toolUseResult.agentId`. `toolUseResult` has
  several shapes. Background launches (`async_launched`, 458 of 467 sampled) carry
  `agentId`, `description` and `prompt`. Foreground results (`completed`) and
  teammates carry `prompt` but no `description`. `forked` results carry neither.
- `transcripts.db` holds no message text. `files.data` holds extracted rows, and
  `reviews.transcript` is a file path. Prompts are readable only from the `.jsonl`
  files while those files exist.
- The transcript cleanup deletes `meta.json` along with the transcript. A
  description that is not stored before then is lost. Agents whose files are already
  gone (`files.on_disk = 0`) cannot be backfilled.

## Proposed shape

An `agents` table in `lib/db.js`, one row per subagent file, with a
`SCHEMA_VERSION` bump:

| Column | Source |
|---|---|
| `agent_id` (primary key) | file name, `agentId` on each line |
| `session_id` | `sessionId` on the first line |
| `agent_type` | `meta.agentType` |
| `description` | `meta.description` |
| `tool_use_id` | `meta.toolUseId` |
| `parent_agent_id` | `meta.parentAgentId` |
| `started_at` | first line's `timestamp` |

The row store writes the row when it reads a subagent file, from the `meta.json` next
to it. One backfill pass reads every meta file still on disk.

A separate table was chosen over a field inside `files.data` because the JSON blob
cannot be queried with SQL, and `bin/review-session` and ad-hoc `sqlite3` queries
would want to join on `agent_id`. A field in the row JSON would need only an
`EXTRACT_VERSION` bump, so it stays the fallback if the table is not worth a schema
change.

## Decisions

- SQL queries during analysis of past transcripts are the only reader (owner,
  2026-11-17). No page or `/api/*` route shows the table.

## Open questions

- Store the prompt as well? Reading it costs nothing extra, since it is the first
  line of the file the row store already reads. Storing it keeps it after the
  `.jsonl` is deleted. The one prompt sampled was 1,755 characters. The
  [Costliest prompts](costliest-prompts.md) idea has the same open question for user
  prompts.
