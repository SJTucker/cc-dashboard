# Model mix: switch between tokens and cost

Clicking the Model mix donut switches it between each model's share of tokens and
each model's share of cost. Asked for on 2026-10-08.

## What was asked for

- **Click the donut to switch.** One click shows each model's share of cost. The
  next click goes back to tokens.

## How the donut works today

- `drawModelMix` in `public/charts/donut.mjs`, called from
  `public/panels/models.mjs`, draws the donut from `data.models`. Slices, the centre
  total, the tooltip, the `aria-label` and the legend percentages all use
  `m.tokens`.
- Each entry in `data.models` already carries `cost` as well as `tokens`, so the
  server needs no change.
- The comment above `drawModelMix` says the donut is sized by tokens on purpose.
  The Cost by model panel (`data-hide-key="costByModel"` in `public/index.html`)
  already shows dollars, and the difference between the two panels is the point:
  "a model can be 40% of volume and 5% of spend". The switch changes that decision,
  so the comment has to change with it.
- Slices use textures from `modelTexture` and colours from `modelColor`. The user is
  red-green colourblind, so texture identifies each model and colour is secondary.
  The cost view must keep the same texture per model.

## Open questions

- **What the click target is.** The whole donut, the centre total, or a small
  "Tokens / Cost" control in the panel header. A click on the donut alone gives no
  hint that the donut can be clicked. A keyboard user also needs a focusable control
  with `aria-pressed` or an equivalent.
- **Whether the choice is remembered.** Row order and collapsed rows are kept in
  `localStorage`. Decide whether the token or cost view is kept the same way, or
  resets to tokens on each page load.
- **The 5 s Today poll.** `loadAndRender` redraws every panel on each poll. The
  selected view has to survive that redraw.
- **Sort order.** Slices are sorted by tokens. In the cost view they should probably
  sort by cost, which moves each model's slice when the view switches.
- **The centre label.** It shows the total tokens with the unit "tokens". In the cost
  view it would show the total cost in dollars.
- **Overlap with Cost by model.** Once the donut can show cost, decide whether the
  Cost by model panel is still needed beside it.
