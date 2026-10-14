# Models panel at the bottom of the Now tab

Asked for on 2026-10-14: show the Models panel (`#modelsPanel` in
`public/index.html`, hide key `costByModel`) at the bottom of the Now tab. It holds
the model share bar with its Tokens/Cost toggle, the per-model table (tokens, cost,
share, $/MTok, thinking) and the Check prices line.

Today the panel is on the Analysis tab (`#tabAnalysis`) and follows that tab's date
range. The Now tab (`#tabNow`) holds Plan usage, Where usage goes, the session
timeline, Live sessions and Reviews.

## Open questions

- Which range the panel covers on the Now tab: today, or the range the Now tab's
  other panels use.
- Whether the panel moves, or shows on both tabs. Both tabs would need a second
  set of element ids, or one panel moved between tabs when the tab changes.
- Whether the Check prices line stays with the panel on Now, or stays on Analysis.
- Its hide key and position in the Now tab's saved layout (`public/layout.mjs`).
