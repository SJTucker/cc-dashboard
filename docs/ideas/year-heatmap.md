# Year heatmap

A calendar of days, one cell per day for a year, shaded by cost, like a GitHub
contribution graph. Recorded on 2026-10-10, from the second round of research
(tokscale draws one).

## What exists

- The weekday-by-hour heatmap (`public/charts/heatmap.mjs`) shows when in the week
  spend happens, summed over the range.
- The All range keeps every stored day, so a year of cells is available once the
  history is that long. It is about 44 days now.

## Open questions

- Whether it adds enough over the Daily cost bars on the All range.
- Shading: one hue in steps of lightness stays readable with red-green
  colourblindness, which the dashboard's charts design for. Do not use a red-to-green
  scale.
- Whether cells mark setup changes, so the calendar doubles as an overview of the
  Setup changes lanes.
