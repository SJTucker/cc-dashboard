# Model mix as a pie chart that fills its panel

Draw the Model mix panel (`#modelMixPanel` in `public/index.html`) as a pie chart, and
make the panel as tall as the Cost by model panel beside it. Asked for on 2026-10-06.

## What was asked for

- **No empty space under Model mix.** The two panels share a `.panel-row`. Cost by
  model is a table with one row per model, so it is several times taller than Model
  mix, and the space under Model mix is empty.
- **A pie chart.** The pie replaces the single bar (`#modelMixBar`) and grows with the
  height of Cost by model.

## Where the layout comes from now

- **The row.** `.panel-row` in `public/style.css` is a grid with
  `grid-template-columns: 3fr 2fr` and `align-items: start`. `start` keeps each panel
  at its own height, which leaves the gap.
- **The bar.** `drawModelMix` in `public/app.js` builds `#modelMixBar` from HTML
  `div`s, one `.mix-seg` per model. Each segment's width is the model's share of
  tokens. Its texture comes from `segmentTexture`, a CSS background. The legend in
  `#modelLegend` labels each model with its share.
- **Tokens, on purpose.** The comment above `drawModelMix` says the bar is sized by
  tokens, not cost. Cost by model already shows dollars, and the difference between
  the two shares is what the panel is for.
- **SVG textures exist.** The SVG charts get their textures from `<pattern>` elements
  built beside `fillFor` in `public/app.js`. A pie drawn in SVG can use the same
  patterns. The user is red-green colourblind, so each slice needs its texture and a
  direct label, not colour alone.

## Open questions

- **Stretch only this row.** Changing `.panel-row` to `align-items: stretch` affects
  every `.panel-row`, including the two `.panel-row.even` pairs. A modifier class on
  the Cost by model row keeps the change to that row.
- **Sizing the pie.** The pie's diameter follows the panel's height, which follows the
  number of models in the table. With one or two models the panel is short and the
  pie is small. Decide on a minimum diameter, and what happens when the panels stack
  to one column on a narrow screen, where Cost by model no longer sets the height.
- **Pie or donut.** A donut has room in the middle for a total, for example total
  tokens in the range.
- **Labels.** Labels on the slices, or the existing legend beside or under the pie.
  Thin slices, such as Haiku at 6%, have no room for a label inside.
- **Tokens or cost.** Keep tokens, as now, or add a toggle to show cost.
- **Redraws.** The pie's size depends on the panel's height, so it has to be redrawn
  when the window resizes or the Cost by model table changes length. Check how the
  other SVG charts in `public/app.js` handle a resize.
