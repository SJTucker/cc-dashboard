# Tool error rate by model

Split the tool error rate by the model that made the call, and by cause. Moved from
README "Extending it" on 2026-10-09.

## Why the cause split matters

Without the cause split the rate misleads. On this machine Opus 5.5 looked twice as error-prone
as Opus 5, but 64 of its 135 errors were the worktree isolation check blocking
commands. That count says where the model ran, not how well it used the tools.

## What exists

- `summariseTools` in `lib/aggregate.js` joins tool uses to tool errors by id, and
  groups errors by tool, detail and cause (`errorCauses`).
- Tool use rows from `extractFile` in `lib/extract.js` hold `key`, `t`, `name` and
  `detail`, with no model. Call rows carry the model and their tool names.

## Open questions

- Whether to add the model to tool use rows in `lib/extract.js`, which changes
  `EXTRACT_VERSION` and re-extracts stored rows, or join through the call rows.
- Which causes to leave out of the rate by default.
