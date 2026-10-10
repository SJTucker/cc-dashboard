# Setup changes: labels on long histories

The date labels and the weekly lane counts of the Setup changes chart collide when the
range holds many days. Found in the whole-branch review on 2026-10-10.

## What happens

- `dateLabelStep` in `public/chart-geometry.js` has two steps, `day` and `monday`.
  Monday labels collide below about 2.3px per day. That is about 85 days in the 194px
  plot at a 400px viewport, and about 250 days at 800px.
- Weekly lane cells place the count text at `cx + 7` in `laneCellNode`
  (`public/charts/setup-changes.mjs`). The text overlaps the next week's glyph once a
  week is narrower than about 25px, about 3.5px per day.
- All has no upper bound, because the transcript store keeps rows past Claude Code's
  cleanup. It is 44 days now, so the data does not reach the limit yet.

## Possible fix

Add a month-start label step to `dateLabelStep`, and month cells in `laneCells`, below
about 3px per day.
