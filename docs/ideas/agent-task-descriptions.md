# Transcript archive and subagent task descriptions

Asked for on 2026-11-17. Two parts of one plan:

1. Keep a gzipped copy of every transcript, because Claude Code deletes transcripts
   older than `cleanupPeriodDays` (30 by default, not set on this machine) and
   `transcripts.db` keeps only extracted usage and tool rows. Prompts, replies and
   tool inputs are lost with the file.
2. Record each subagent's task description in `transcripts.db`, so SQL queries over
   past transcripts can read what each subagent was asked to do.

## Decisions

- SQL queries during analysis of past transcripts are the only reader of the agent
  table (owner, 2026-11-17). No page or `/api/*` route shows it.
- Back up whole transcripts as gzipped copies under `<cfg>/cc-dashboard/archive/`
  (owner, 2026-11-17). Raising `cleanupPeriodDays` was the other option.
- The agent table stores the description only. The prompt is the first line of the
  subagent's `.jsonl`, and the archive keeps that file.
- The archive is never pruned. Measured growth is about 11 GB per year.

## Measured on 2026-11-17

- `<cfg>/projects` holds 2,484 `.jsonl` files, 3.2 GB, the oldest from 2026-10-06.
  That is about 107 MB per day.
- gzip shrinks a sample of 62 files to 29% of their size: about 31 MB per day.
- `transcripts.db` has 10,827 file rows. 8,384 have `on_disk = 0`. Those
  transcripts, back to 2026-08-28, are already gone. The first archive run saves
  only what is still on disk.
- The disk has 550 GB free.

## What the db has today (checked 2026-11-17)

- There is no per-agent table. `lib/rowstore.js` reads every `*.jsonl` under
  `<cfg>/projects`, so each `<session>/subagents/agent-<id>.jsonl` gets its own
  `files` row keyed by path. The rows `lib/extract.js` builds for that file are
  stored as JSON in `files.data`.
- Call rows carry `agentId`, `sessionId` (the parent's) and `attributionAgent` (the
  agent type). Agent tool-use rows keep only `input.subagent_type` as `detail`
  (`toolDetail` in `lib/transcript-lines.js`).
- `lib/extract.js` never reads `description` or `meta.json`. Other readers do,
  outside the db: `lib/transcript-index.js`, `lib/orchestrations/parse.js`,
  `lib/orchestrations/discover.js`, `bin/transcript-index` and `bin/orch-report`.
- `transcripts.db` holds no message text. `reviews.transcript` is a file path.

## Where the agent data comes from

- `agent-<id>.meta.json` sits next to each subagent transcript. It holds `agentType`,
  `description` (the Agent tool's short description, such as "Mockup via
  artifact-design"), `toolUseId`, `spawnDepth`, `pickedEffortModel` and, on some
  files, `model` and `parentAgentId`. All 2,152 subagent transcripts on disk had a
  meta file. 2,124 had a `description`. The 28 without one were not inspected.
- The prompt is the first line of the subagent's own `agent-<id>.jsonl`, as a `user`
  message. All 465 sampled files whose parent recorded a prompt matched it there.
- The parent session's Agent tool result has several shapes. Background launches
  (`async_launched`, 458 of 467 sampled) carry `agentId`, `description` and
  `prompt`. Foreground results (`completed`) and teammates carry `prompt` but no
  `description`. `forked` results carry neither. `meta.json` is the reliable source.

## Proposed shape

### Archive

- A `bin/archive-transcripts` script mirrors `<cfg>/projects` into
  `<cfg>/cc-dashboard/archive/`: `<proj>/<session>.jsonl.gz`,
  `<proj>/<session>/subagents/agent-<id>.jsonl.gz` and each `agent-<id>.meta.json`.
- A transcript only grows, so no "finished" test is needed. The script records how
  many bytes of each file it has archived and appends the new bytes as another gzip
  member. `zlib.gunzipSync` and `zcat` read concatenated members as one stream
  (checked with Node 22.23 on 2026-11-17). A resumed session that appends days later
  adds one more member.
- A file shorter than its archived length was rewritten. The old archive is renamed
  aside with a timestamp and a fresh copy is written, so neither version is lost.
  The [transcript rewrites](transcript-rewrites.md) idea covers the same case for
  rows.
- The mod runs the script at each interactive session start, beside the other
  `bin/` scripts it runs in `mod/hooks/register.ts`. Every file changed before a
  session starts is archived by the next session start, well inside the 30 days.
- An `archive` key in `<cfg>/cc-dashboard/settings.json` (`lib/settings.js` and
  `parseDashboardSettings` in `mod/hooks/setup.ts`), default on. Off stops the mod
  running the script, and the script exits without work if run by hand.
- gzip, because `zlib.zstdCompressSync` needs Node 22.15 and the floor is 22.13.
- `SETUP.md` gains the `archive/` folder and the setting.

### Agent table

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
to it. One backfill pass reads every meta file still on disk. A separate table was
chosen over a field inside `files.data` because the JSON blob cannot be queried with
SQL.

## Open questions

- Not checked: whether Claude Code's cleanup runs before the mod's `session.start`
  hook. It matters only for a file untouched for 30 days and never archived, which
  can happen only on the first run.
- Later, not in this plan: the row store could re-extract from the archive after an
  `EXTRACT_VERSION` bump, so new fields reach history older than 30 days.
