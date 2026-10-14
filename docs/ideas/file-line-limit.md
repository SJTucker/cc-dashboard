# File line limit

Add a line limit for source files, and split the files over it. Start with the files
that sessions read and edit most. Asked for on 2026-10-13.

## Why

Each Read result stays in context for the rest of a session or subagent run, and
every later request pays for it again. A file over about 500 lines has to be read in
parts with `grep -n` and an offset, and a part read misses context. Smaller files
make a full read cheap.

## Sizes on 2026-10-13

Source files over 450 lines:

| File | Lines | Commits since 2026-09-01 |
|---|---|---|
| `public/style.css` | 1,566 | 92 |
| `mod/hooks/register.ts` | 1,210 | 40 |
| `lib/aggregate.js` | 564 | 14 |
| `lib/extract.js` | 549 | 14 |
| `public/charts/setup-changes.mjs` | 492 | 9 |

Test files over 450 lines: `mod/hooks/register.test.ts` (1,944),
`test/rowstore.test.js` (1,395), `test/scan.test.js` (1,246), `test/api.test.js`
(1,021), `test/sessions.test.js` (791), `test/extract.test.js` (500),
`test/chart-geometry.test.js` (490), `test/review.test.js` (488),
`test/limits.test.js` (463), `test/rtk.test.js` (462).

The most edited files since 2026-09-01 are `public/app.js` (119 commits, since split
up and removed), `README.md` (100), `public/style.css` (92), `public/index.html` (84),
`test/api.test.js` (52) and `server.js` (51).

## Constraints

- **`register.ts` can only shed pure code.** The engine follows `$` only into
  functions declared in the same file, and an event takes one `on(...)` hook without
  a matcher. Every function that takes `$`, and every hook, stays in `register.ts`.
  Pure helpers can move out, as `handoff.ts`, `limits.ts` and `setup.ts` already
  have. See the mod engine facts recorded for Claude Code 2.1.296.
- **`register.ts` stays near 1,240 lines.** The pure helpers are moved out into
  `statusline.ts`, `activity.ts`, `text.ts`, `setup.ts` and `handoff.ts`, which took
  `register.ts` from 1,375 to 1,240 lines on 2026-10-13. What remains takes `$`, is a
  hook, or reads the per-session maps (`forgetSession`), so
  the engine constraint keeps the file above about 1,150 lines. A limit, if enforced,
  needs an allowlist entry for `mod/hooks/register.ts`.
- `register.test.ts` holds the contract block that `test/mod-contract.test.js` reads
  between `// contract:begin` and `// contract:end`. A split must keep that block in
  one file, or the contract test must learn the new path.

## Open questions

- **The limit.** 500 lines matches the point where the global CLAUDE.md asks for a
  part read. Do tests and CSS get the same limit, or a higher one?
- **Enforcement.** A `node:test` check over `git ls-files` that fails above the limit,
  with an allowlist of current offenders whose entries may only shrink. Or a
  pre-commit hook. Or a rule in CLAUDE.md only.
- **Measuring reads.** Git counts edits, not reads. Reads need the transcripts:
  `Read` calls by `file_path`, including the subagent transcripts under
  `<session id>/subagents/`, plus `sed -n`, `cat` and `head` runs in `Bash`. A first
  count over the main transcripts alone found few Reads, because most reads happen
  in subagents or through `sed`. The [What fills the context](context-fillers.md)
  idea covers repeated reads too and may share the work.
- **Order.** Rank by reads × size once reads are counted. Until then, start with
  `register.ts` and `style.css`, which are both large and often edited.
