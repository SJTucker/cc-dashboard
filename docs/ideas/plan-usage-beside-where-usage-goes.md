# Plan usage beside Where usage goes

Show the Plan usage panel and the Where usage goes panel side by side in one row,
instead of one above the other at full width. Asked for on 2026-10-10, with a
screenshot of the two panels stacked.

## What exists

- `#limitsPanel` and `#attributionPanel` are separate full-width sections in
  `public/index.html`. Two panels share a row elsewhere through
  `<div class="panel-row even">` (Daily cost and Daily tokens, for example).
- `.panel-row.even` is two equal columns (`public/style.css`). Below 880px every
  `.panel-row` drops to one column. A row with a hidden panel
  (`.panel-row:has(> [data-user-hidden])`) also drops to one column.
- Plan usage shows on Today only. Where usage goes hides when the range has no cost.
- Where usage goes lays out its own two-column `.usage-grid` (thread split and
  context split, then the Skills and Subagents lists). At half width each column is
  a quarter of the page.
- Panel rows can be dragged into a new order. `orderRowKeys` in `public/layout.js`
  merges the saved order with the order in `index.html`. Wrapping both panels in
  one row changes the row keys, so a saved order puts the new row after the row
  that precedes it in `index.html`.

## Open questions

- Which ranges get the row. On 7d, 30d and All, Plan usage is hidden, so Where
  usage goes would sit alone in a half-empty row unless the row drops to one column.
- Whether `.usage-grid` stacks to one column inside a half-width panel.
- The bar widths in Plan usage at half width, and whether the "N% used" text still
  fits beside the bar.
