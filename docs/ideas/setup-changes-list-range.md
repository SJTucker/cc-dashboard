# Setup changes: limit the day buttons to the range

The row of day buttons in the Setup changes · Before and after panel lists every
change back to 8/24 on every range. The user expected it to show only the last 14
days. Raised on 2026-10-08.

## What was asked for

- **Check why the list still starts at 8/24.** The user thought an earlier change
  limited the panel to the last 14 days.

## What the code does

- Commit `1ad971d` ("make the setup changes panels follow the range picker") limited
  the charts' time axis only. `visibleDays` in `public/app.js` returns 14 days for
  the Today and 7d ranges, the picked day count for 30d and 90d, and null for All.
  `chartDomain` narrows the axis with that number.
- The day buttons are built from `report.markers` with no range filter.
  `groupMarkersByDay(report.markers)` in the Setup changes render code groups every
  marker by day. The comment above `markerInDomain` says this is intended: "A marker
  just outside it ... keeps its place in the marker button list but draws no glyph".
- So on every range the list starts at the oldest marker, 8/24, while the charts
  show 14 days on Today and 7d.
- The transcript row store (branch `feat/transcript-row-store`) keeps history past
  `cleanupPeriodDays`. Once it merges, the All range's history keeps growing, and so
  does this list.

## Open questions

- **Which days the list shows.** Use the same span as the charts (`chartDomain`), so
  a button only appears for a change the charts can draw. On All, the list keeps
  every change.
- **The selected change when it falls outside the range.** `selectedMarkerKey`
  defaults to the newest change. Decide what happens when the user had picked an
  older change and then narrows the range: fall back to the newest change in range,
  or keep the old one selected and visible.
- **A range with no changes.** Show an empty-state line, as other panels do when a
  range has no data.
- **The before/after numbers.** They are computed on the server from each change's
  own 7-day windows and do not depend on the range. Filtering the list does not
  change them.
