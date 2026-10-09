# Per-project breakdown

Usage and cost grouped by project. Moved from README "Extending it" on 2026-10-09.

## What exists

- Transcript folders under `<cfg>/projects` are the project path with `/` encoded as
  `-`, for example `-Users-you-code-myapp`.
- `aggregate` in `lib/aggregate.js` has no project dimension. The only project
  grouping is the display grouping of ended sessions in `public/session-groups.js`.
- The README left this out because costs are estimates. Per-project estimates were
  judged not worth the extra code.

## Open questions

- Decoding: a folder name cannot tell `my-app` from `my/app`. Use each session's
  `cwd` from its transcript instead of the folder name.
- Whether worktrees of one repository count as one project.
- Whether a per-project cost estimate is useful enough to show.
