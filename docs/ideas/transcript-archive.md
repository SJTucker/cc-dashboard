# Keep whole transcripts after Claude Code deletes them

Asked for on 2026-11-17, while designing
[Subagent task descriptions](agent-task-descriptions.md). Claude Code deletes
transcripts older than `cleanupPeriodDays` (30 by default, not set in this
machine's settings). `transcripts.db` keeps only the extracted usage and tool rows,
so prompts, replies and tool inputs are lost with the file. The owner wants the
whole transcript backed up, so analysis of past sessions can read it.

## Measured on 2026-11-17

- `<cfg>/projects` holds 2,484 `.jsonl` files, 3.2 GB, the oldest from 2026-10-06.
  That is about 107 MB per day.
- gzip shrinks a sample of 62 files to 29% of their size: about 31 MB per day, or
  11 GB per year.
- `transcripts.db` has 10,827 file rows. 8,384 of them have `on_disk = 0`. Those
  transcripts, back to 2026-08-28, are already gone and cannot be recovered.
- The disk has 550 GB free.

## Options

- **Raise `cleanupPeriodDays`** in `~/.claude/settings.json`. No code changes.
  Transcripts stay where every reader already looks. Costs about 3.2 GB per month
  uncompressed. Not checked: whether a large `<cfg>/projects` slows Claude Code's
  `/resume` list or startup.
- **Archive copies.** The server or a `bin/` script copies each `.jsonl` (and its
  `meta.json`) into `<cfg>/cc-dashboard/archive/`, gzipped, once the file stops
  changing. Costs about a third of the disk space and leaves Claude Code's settings
  alone. Readers must look in two places. `zlib.zstdCompressSync` needs Node 22.15,
  above the 22.13 floor, so gzip or brotli.
- Storing transcripts inside `transcripts.db` was rejected. The server opens that
  file on every start, and 11 GB a year would grow it 50 times over.

## Open questions

- Which option?
- For an archive: when is a file finished? A session can be resumed days later and
  append to the same file. The [transcript rewrites](transcript-rewrites.md) idea
  covers files that lose lines, which an archive copy would also need to handle.
- Does a setting turn the archive off, and which calls stop when it does?
