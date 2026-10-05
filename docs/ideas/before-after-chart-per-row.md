# Before and after: chart on the right, one chart per row

Two changes to the Setup changes before-and-after panel (`#beforeAfterPanel` in
`public/index.html`). Asked for on 2026-10-05.

## What was asked for

- **Swap the columns.** The table (`#beforeAfterTable`) goes on the left and the
  daily chart (`#bashDailyChart`) goes on the right. Today `.ba-grid` puts the chart
  first.
- **One chart per row.** Clicking a row of the table shows that metric's daily chart.
  Today the chart always shows the median Bash result on the main thread, whichever
  row the reader is looking at. The rows are `BA_ROWS` and `RTK_ROWS` in
  `public/app.js`:
  - Session start context
  - Bash result, median
  - Bash result, p90
  - Cost per prompt, median
  - API calls per prompt, median
  - Cache hit rate
  - Tokens kept per command (rtk)
  - Share of output filtered (rtk)

## Open questions

- **Daily series.** The report has a daily series for the Bash median only. Each
  other row needs one per day, computed the same way as its 7-day value. The rtk rows
  come from rtk's `history.db`, not the transcripts, so their daily series needs a
  separate query in `lib/rtk.js`.
- **The default row.** Which row is selected when a change is picked: Bash result,
  median, as today, or the first row.
- **Showing the selection.** The selected row needs a marker that does not rely on
  colour, for example a left border or a pointer glyph, because the user is red-green
  colourblind.
- **Keyboard.** The rows need to be focusable buttons or have `aria-selected`, so a
  keyboard user can switch charts.
- **The chart title.** `.usage-group-title` above the chart names the Bash median
  today. It has to follow the selected row.
- **Narrow screens.** When `.ba-grid` stacks to one column, decide whether the chart
  goes below the table, as the swap implies, or stays on top.
