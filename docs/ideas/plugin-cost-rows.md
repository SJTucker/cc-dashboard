# Cost by plugin

Add a Plugins list to Where usage goes, beside Skills and Subagents, from the
`attributionPlugin` field on assistant lines. Recorded on 2026-10-10, from the second
round of research (ccusage issue #1692).

## What exists

- Assistant lines carry `attributionPlugin`. The transcripts on this machine held
  15,881 such lines on 2026-10-10, most of them `superpowers`, with `figma` and
  `ponytail` after it.
- `lib/extract.js` copies `attributionSkill` onto call rows, and `lib/aggregate.js`
  sums cost per skill from it (`skillCost`). Nothing reads `attributionPlugin`.
- Claude Code's OpenTelemetry export puts the same attribute on `cost.usage` as
  `plugin.name`.

## Why

A plugin's skills are already listed one by one. A plugin total answers whether a
plugin is worth keeping installed, which is the same question the Setup changes
panel asks after a plugin install.

## Open questions

- Copying the field onto call rows raises `EXTRACT_VERSION`. Rows from deleted
  transcripts would have no plugin.
- Whether a plugin's row counts its invocations, and how, given a plugin can hold
  skills, agents, hooks and MCP servers.
- Whether `attributionPlugin` is set on the calls made inside a plugin's subagent.
