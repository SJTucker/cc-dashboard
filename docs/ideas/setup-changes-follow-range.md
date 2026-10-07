# Setup changes follow the range picker

Make both Setup changes panels follow the range picker instead of always showing all
history. Asked for on 2026-10-07.

## What was asked for

- **Today shows two weeks.** On the Today range, both panels show the last 14 days.
- **The other ranges show their own span.** 7d, 30d, 90d and All show 7, 30, 90 days
  and all history.
- **Both panels.** Context at session start (`#sessionStartChart`) and Before and after
  (`#beforeAfterPanel`).

## Why the panels show all history today

The 2026-09-24 setup changes spec chose all history on purpose: "A before/after
comparison needs data on both sides of a change, and a 7-day range would cut it off."
The README's Setup changes section and the panel note in `public/index.html` both say
"all history, whatever range is picked".

That reason applies to the 7-day before and after windows, not to what the charts
draw. The range can limit what is drawn while the windows still read from the full
history.

## Where the work happens

- `/api/changes` in `server.js` reads the all-history scan (`getCached(null)`) and
  returns every session, every daily value and every marker.
- `timeDomain(report)` in `public/app.js` sets the shared x-axis of both charts from
  `report.sessions` and the daily series.
- The marker list in the Before and after panel lists every marker.
- The range buttons are `data-days` in `public/index.html`: `today`, `7`, `30`, `90`,
  `all`.

## Open questions

- **Client or server.** The client can cut the x-axis to the range and keep one
  all-history response. Or `/api/changes` can take a `days` parameter. Cutting on the
  client means switching ranges needs no new request.
- **The 7d range.** A 7-day view shows at most one side of any change's before and
  after windows. Decide whether 7d also shows 14 days, as Today does.
- **The marker list.** Decide whether the Before and after panel lists only changes
  inside the range, or every change, with the chart scrolling to the picked one.
- **A window that crosses the range edge.** A change 10 days back on the Today range
  has a before window that starts 17 days back, beyond the 14 days shown. Decide
  whether the shaded window is clipped at the axis, and whether the table still uses
  the full 7 days. It should, so the numbers do not change with the range.
- **The weekly median line.** The step line on Context at session start is a weekly
  median. On a 14-day axis it has two or three steps. Decide whether it stays weekly.
- **Overlap with the per-row chart work.** The spec
  `docs/superpowers/specs/2026-10-07-before-after-chart-per-row-design.md` also
  changes `timeDomain`. Build the per-row chart first, or fold this idea into it.
