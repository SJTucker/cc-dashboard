# Re-extract history from the transcript archive

Raised on 2026-11-17 while planning the transcript archive (plan
`docs/superpowers/plans/2026-11-17-transcript-archive.md`, untracked). That plan keeps
a gzipped copy of every transcript under `<cfg>/cc-dashboard/archive/`.

## What was asked for

When `EXTRACT_VERSION` in `lib/extract.js` goes up, the row store re-reads only the
transcripts still in `<cfg>/projects`. Claude Code deletes those after
`cleanupPeriodDays`, which is 30 days by default. A new field therefore reaches only
the last 30 days, and rows older than that keep the old shape. They are upgraded in
memory by `MIGRATIONS` in `lib/store.js` where a migration can be written.

The idea is to re-extract from the archive copy when the source is gone, so a new
field reaches all archived history.

## Decisions

None yet.

## Open questions

- Which files to re-read: every `files` row with `on_disk = 0` and an archive copy,
  or only rows whose stored `version` is below `EXTRACT_VERSION`.
- How to read the archive: the row store's extract takes a path and reads the file.
  It needs a gunzip step, or a version of `extractFile` that takes a stream.
- What a re-read costs: the archive grows about 11 GB a year gzipped, and a full
  re-read after every version bump may be slow. A background pass at low priority
  may be needed.
- Rows for files deleted before the archive shipped (8,384 on 2026-11-17) have no
  archive copy and keep their stored rows.
