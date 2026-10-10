# Sticky plan limit banner

Keep the "Nearing your plan limit" banner on screen while the page scrolls.
Asked for on 2026-10-10.

## What exists

- `#limitsBanner` (`public/index.html`) sits at the top of `<main>`, above
  `#statusBanner`. `drawLimitsBanner` in `public/panels/limits.mjs` shows it on
  every range when a window passes `LIMIT_WARN_PERCENT`, with the heading
  "Nearing your plan limit", or "Nearing today's budget" for the day budget.
- The page header is already `position: sticky; top: 0; z-index: 10`
  (`public/style.css`). A sticky banner has to sit below the header, so its `top`
  is the header's height, which changes with the viewport width.
- The banner is styled by `.status-banner` and `.limits-banner`, with a 24px bottom
  margin.

## Open questions

- Whether the banner moves into the sticky header instead, which avoids measuring
  the header's height.
- How much height a sticky banner may take on a 400px viewport, where the header
  already takes a share of the screen.
- Whether "Nearing today's budget" is sticky too, or only "Nearing your plan limit".
