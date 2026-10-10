# Counts for skills and subagents in Where usage goes

Show a count next to each row of the Skills and Subagents lists in Where usage
goes, as well as the share of cost. Asked for on 2026-10-10.

## What exists

- `renderAttribution` in `public/panels/attribution.mjs` draws the two lists with
  `drawHBars`, the top 8 rows each. Each row shows its share of total cost, and its
  tooltip shows the cost.
- The rows come from `aggregate` in `lib/aggregate.js`. It sums cost per skill
  (`skillCost`, keyed by `row.attributionSkill`) and per subagent type (`agentCost`,
  keyed by `row.attributionAgent`), and `byCost` turns each map into `{ name, cost }`
  rows. No count is kept.
- Both lists are collapsed by default (`group-collapsed` in `public/index.html`).

## Open questions

- What to count. Candidates: invocations (Skill tool calls, Agent tool calls), API
  calls attributed to the skill or subagent, or sessions that used it. Invocations
  is the number a user would recognise.
- Whether the count shows in the row text (for example `12× · 4.3%`), in the
  tooltip only, or in the collapsed list title as a total.
- Whether adding a count to the rows changes `EXTRACT_VERSION` in
  `lib/extract.js`, which re-extracts stored rows.
