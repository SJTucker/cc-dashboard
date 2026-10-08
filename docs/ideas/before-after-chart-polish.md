# Before and after chart polish

Tidy the daily chart on the right of the Before and after panel (`#baDailyChart`).
The user called it "almost looks good" but "a little messy and off". Asked for on
2026-10-07, from a screenshot with the 10/7 change and the Bash result p90 row
picked on the Today range.

## What looked off in the screenshot

- **Empty space under the chart.** `.ba-grid` (`public/style.css`) puts the table
  and the chart side by side with `align-items: start`. The chart is about 270px
  tall. The table beside it, with the rtk rows and the notes below it, is about
  twice that. The right column is empty below the x-axis.
- **A change at the right edge.** The picked change was on 10/7, the last day on the
  axis. The after window is a sliver at the edge. The after median line is a short
  stub past the marker line. The before median runs across the whole shaded
  window.
- **The top of the y-axis.** The "2k" label sits just under the chart title, and the
  tallest bar reaches the top of the plot. The axis has no 0 label.
- **Two x-axis labels.** A 14-day axis shows only 9/28 and 10/5. `drawTimeAxis`
  in `public/app.js` labels each Monday and nothing else, so a 14-day axis gets two
  labels. The Context at session start chart has the same axis and the same two
  labels, because both Setup changes charts call `drawTimeAxis`. The user asked on
  2026-10-08 for more dates to be labelled.
- **No legend.** Nothing on the chart says what the pale bars (inside the 7-day
  windows), the dark bars (outside), the dashed white line (the before median) or
  the orange line (the after median, and the change itself) mean.
- **Days with no data.** Days without a value draw no bar, so the gaps look like
  missing bars rather than days with nothing to count.
- **A stale label.** The `aria-label` on `#baDailyChart` in `public/index.html`
  says "Median context at session start, tokens per day", whichever row is picked.

## Where the work happens

- `drawMetricChart(container, report, marker, row)` in `public/app.js` draws the
  bars, the shaded windows, the median lines and the marker line.
- `drawYAxis` and `drawTimeAxis` in `public/app.js` draw the axes for both Setup
  changes charts.
- `.ba-grid`, `.window-before`, `.window-after` and `.day-bar` in
  `public/style.css`.

## Open questions

- **Chart height.** Decide whether the chart grows to the table's height, stays
  fixed and the space below it holds something else (the legend, the
  "other changes in this window" note), or the panel stacks the chart above the
  table.
- **A change near the edge.** Decide whether the axis pads past the last day so a
  change on the last day still shows some of its after window, or whether a short
  after window gets a label such as "1 day so far".
- **Legend form.** A row of swatches above the chart, or labels at the ends of the
  median lines ("before 1.8k", "after 1.8k").
- **Colour.** The user is red-green colourblind.
  Pale versus dark bars and white versus orange lines must still read
  apart. Use a texture or a line style, not hue alone.
- **Axis label spacing.** Pick the step from the axis length. For example, label
  every day or every second day on a 14-day axis, and each Monday on longer ones.
  Check that labels do not overlap at the narrowest panel width.
- **Empty days.** Decide whether a day with no data draws a zero tick on the
  baseline, or stays empty.
