# Hide the status strip when the window is narrow

Asked for on 2026-10-14: hide the header's status strip below a certain window width.

The status strip is `#statusStrip` in `public/index.html`, styled by `.status-strip`
in `public/css/header.css`. It holds Link live, Sync, Sessions, API calls, and the
plan limit warning (`#stripLimit`).

At the width the owner was using, the strip stays in the first header row. The three
today numbers (`.sticky-stats`: Cost today, Tokens today, Record day) and the menu
button wrap onto a second row.

## Already in place

- `.status-strip:has(.strip-limit:not([hidden])) .strip-extra` hides Sessions and API
  calls while the plan limit warning shows, so the strip stays one row.
- The breakpoints already used in `public/css/` are 720px and 900px. No rule in
  `header.css` depends on width.

## Open questions

- The width to hide below. A useful value keeps the title, the tab switch and the
  three today numbers on one row once the strip is gone.
- Whether the plan limit warning stays visible when the strip is hidden. It lives
  inside the strip, so a plain `display: none` on the strip hides it too.
- Whether Link live needs another place to show the connection state, since it is
  the only sign that live updates stopped.
- Whether to hide the whole strip, or drop items one at a time (Sessions and API
  calls first, then Sync), as the plan limit rule already does.
