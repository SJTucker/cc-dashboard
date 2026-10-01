# Mark Claude Code updates that could change usage

Claude Code changes under the setup. An update can change token use or tool
behaviour, and that change would otherwise be read as an effect of the user's own
edits. Mark the updates whose changelog entry could affect what the Setup changes
panels measure. Asked for on 2026-10-01, split out of
[auto-setup-changes.md](auto-setup-changes.md).

## Decided (2026-10-01)

- **An agent judges each version.** It reads each new version's changelog entry and
  decides whether it could change what the Setup changes panels measure. Relevant
  means the entry mentions tokens, prompt caching, the context window, compaction,
  tool behaviour or tool output size, subagents, or default model or effort settings.
- **Only relevant versions are shown.** A version judged not relevant gets no marker
  and appears in no list.
- **The marker carries a short summary.** The agent writes a one-line summary of only
  the relevant part of the entry, and the marker shows that summary.
- **The marker's time comes from the transcripts.** It is the time of the first call
  made on that version, because the changelog has no dates.

## Finding versions

Every transcript line carries `version`, so the scan can find the first call made on
each version. The README's "Extending it" list left version markers off the marker
row because 23 versions shipped in one month here, several on the same day. The
judging step is what keeps the row readable.

## The changelog

`CHANGELOG.md` in the `anthropics/claude-code` GitHub repository, at
`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`. Each
version is a `## 2.1.286` heading with bullet points under it.

## Running it in the mod

- **The trigger is a slash command the mod registers**, for example
  `/judge-updates`, with `$.command.register` in `session.start` and a `command.run`
  hook. The dashboard server then still makes only one outbound request, Check
  prices.
- **The fetch** is `$.http.fetch` on the changelog URL.
- **The judging** is `$.model.complete({ model: 'haiku', prompt })`. It runs on the
  session's own login, with no API key and no `claude -p`. Several new versions go in
  one call.
- **Verdicts** go in a cache file, for example
  `~/.claude/cc-dashboard/updates.json`, mapping each version to its verdict and
  summary, so each version is judged once. Editing that file overrides a verdict.
  `lib/changes.js` reads it and adds a marker for each relevant version.

## Open questions

- **Transcript lines.** The API docs say `$.model.complete` carries no history.
  Whether it writes a line under `~/.claude/projects` is not verified. One test call
  settles it. If it writes none, the dashboard's totals leave out the judging cost.
  If it writes one, the scan counts the judging calls.
- **The prompt.** The topic list above needs to become a prompt that also sets the
  summary length, for example at most 15 words.
- **A marker kind.** `KINDS` in `lib/changes.js` has no kind for a Claude Code update.
  A new kind such as `claude-code` needs its own marker shape.
- **The README.** The "One network request, on demand" bullet needs to say the mod's
  command makes a second request, from Claude Code, not from the server.
