# Hide panels

Let the user hide dashboard panels they do not use, and skip the work behind a hidden
panel. Asked for on 2026-10-05.

## What was asked for

- **An "x" button on each panel** hides it. Panels are the `section.panel` elements
  in `public/index.html`.
- **A hamburger menu in the top right** lists the hidden panels. Choosing one shows
  it again.
- **No computation for a hidden panel.** A hidden panel's data is not fetched and its
  chart is not drawn.

## Where the work happens now

- **Requests per panel.** `public/app.js` makes these requests:
  - `loadAndRender` fetches `/api/summary` and `/api/rtk`.
  - Separate loaders fetch `/api/limits`, `/api/sessions/live`, `/api/records`,
    `/api/prices` and `/api/changes`.
- **The all-history scan.** `/api/changes` and `/api/records` share the all-history
  scan (`getCached(null)` in `server.js`). When both Setup changes panels and the
  panels that use `/api/records` are hidden, that scan never needs to run.
- **Several panels per request.** `/api/summary` feeds most panels at once. Hiding one
  of them saves its drawing time but not the request.

## Open questions

- **Panels without an id.** Five `section.panel` elements in `index.html` (lines 159,
  166, 175, 182 and 266) have no `id`. Each needs one, so its hidden state can be
  stored.
- **Where the hidden list is stored.** `localStorage` is the simplest option. It is
  per browser, which suits a local dashboard.
- **Panel pairs.** Some panels share data, for example `sessionStartPanel` and
  `beforeAfterPanel` both use `/api/changes`. Decide whether they hide separately or
  together.
- **Splitting `/api/summary`.** Skipping a request only saves server work when the
  request feeds hidden panels alone. Splitting `/api/summary` by panel would save more
  but is a larger change.
- **Layout.** Decide whether a hidden panel leaves a gap or the grid closes up, and
  whether the header cards count as panels.
- **Keyboard and screen readers.** The "x" button needs an `aria-label` naming the
  panel. The menu needs to be reachable by keyboard.
