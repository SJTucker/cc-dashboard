# What Claude Code does with large Bash output

Measured 2026-10-10 on Claude Code 2.1.296 with Opus 5.5, to decide how the rtk
panels estimate the tokens a command would have put into context without rtk.
The constants in `lib/rtk.js` come from this note.

## Claude Code's limits

Source: https://code.claude.com/docs/en/tools-reference ("Bash tool" > "Output
limits") and the `bashOutputMaxChars` setting. Applies from v2.1.261.

- Output up to about 30,000 characters arrives inline in full.
- A successful result over that is saved to a file in the session directory. The
  model gets the path and a preview of the first 2,000 characters.
- A failed result over that gets a head-and-tail excerpt of about 10,000
  characters. No file is saved.
- Exit 1 counts as success only for `grep`, `rg`, `egrep`, `fgrep`, `find`,
  `diff`, `test`, `[`, `git diff` and `git grep`.

rtk counts a token as 4 characters: a 6,462-byte file was logged as 1,616
tokens. In rtk's units the limits are 7,500 tokens inline, a 2,500-token excerpt
and a 500-token preview.

## How the transcript marks them

- Saved to a file: the `tool_result` content starts with
  `<persisted-output>\nOutput too large (35.6KB). Full output saved to: <path>\n\nPreview (first 2KB):`.
  The line's `toolUseResult` also has `persistedOutputPath` and
  `persistedOutputSize`.
- Excerpt: `is_error: true`, content starts `Exit code N`, and the middle holds
  `... [N characters truncated] ...`.
- The transcript's `tool_use.input.command` is the command before the rtk hook
  rewrote it.

## Evidence 1: transcript history

All transcripts under `~/.claude/projects/` (versions 2.1.248 to 2.1.296) hold
254 Bash results over the limit, all from 2.1.263 or later: 205 saved to a file
and 49 excerpts. 124 of them ran without an rtk rewrite.

| Case | n | Inline tokens | Follow-up tokens | Total, median | Total, mean |
|---|---|---|---|---|---|
| Saved to a file | 98 | about 555 | 0 in 62% of cases, max 19,927 | 560 | 2,931 |
| Excerpt | 26 | 2,510 | none possible | 2,510 | 2,510 |

- Follow-ups were `Read` (26 calls), `tail` (11), `sed` (8), `grep` (6), `cat` (4).
- 95 of the 98 saved results and all 26 excerpts came from subagents, mostly
  implementer and reviewer agents running `node --test`.
- Saved results from test runners, builds and linters (n = 18): median 724,
  mean 783 tokens including follow-ups.

## Evidence 2: controlled runs

15 `claude -p` sessions in a clone of this repo, three per scenario, with the
user's normal settings, `CLAUDE.md`, plugins and `--permission-mode auto`. A stub
`rtk` first on `PATH` swallowed `rtk hook claude`, so no command was rewritten.
rtk's database gained no rows for the clone during the runs. Each prompt said
"Run `<command>`". Total cost $3.88.

Tokens of the command's output that reached the model, including follow-ups:

| Scenario | Raw | Run 1 | Run 2 | Run 3 | What the model did |
|---|---|---|---|---|---|
| Passing `node --test` | 37,460 | 187 | 189 | 434 | Piped to `tail -30`, then a narrow `grep` |
| Failing `node --test` | 37,856 | 1,261 | 1,835 | 116 | Piped through `grep "not ok"` or `tail -80` |
| `grep -rni "date"` over the repo | 20,220 | 7,230 | 7,213 | 7,230 | Counted with `grep -c`, then re-ran excluding `test/` |
| `git diff` of 8 files | 11,296 | 11,475 | 11,475 | 11,475 | `--stat`, then the diff in 3 or 4 parts under the limit |
| `cat public/style.css` | 10,685 | 12,751 | 12,743 | 6,413 | Ran it as given, then read the saved file |

- The model narrowed the command before running it in 12 of 15 runs. Only
  `cat` reached the limit.
- The diff runs follow the user's `CLAUDE.md`, which says to run `--stat` first
  and read one file at a time.
- `Read` adds line numbers, so reading a saved file can cost more than the raw
  output.

## Conclusion

How much of a large output reaches the model depends on what the model needs
from it.

- Status commands (test runners, type checks, linters, builds): a few hundred
  tokens, whatever the raw size. History mean 783 (n = 18), controlled-run mean
  670 (n = 6). The rtk panels use 750.
- Content commands (`read`, `cat`, `diff`, `git diff`, `git show`, `log`): close
  to the whole output. The model splits it or reads the saved file.
- Searches and everything else: about what fits inline. The `grep` runs took
  7,200 tokens, near the 7,500 inline limit.

## Limits of this evidence

- One repo, one model, one user's `CLAUDE.md`. Another model or instructions
  could narrow less.
- The history is mostly subagents. The controlled runs are the only main-thread
  sample.
- Each controlled scenario ran three times.
