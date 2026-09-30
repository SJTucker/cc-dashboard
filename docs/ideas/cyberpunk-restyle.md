# Cyberpunk restyle

Make the dashboard's design cooler and a little more cyberpunk. "A little" means
restyling the existing dark theme. The layout and the information stay as they are.

The current look has a dark navy background, monospace headings and values, an amber
accent for cost and the live dot, and cards with thin borders.

## Constraints

- Chart series are told apart by texture, not colour alone. Stacked bars use solid
  fills against hatching, because the dashboard's user is red-green colourblind. Any
  new palette keeps that. The usual cyberpunk neon red and green pair would fail it.
- No new dependencies and no CDN assets. The Content-Security-Policy is
  `default-src 'self'`, so any font must be a file served from `public/`.
- The row drag handle (`.row-handle`), the dragged row (`.row-dragging`) and the
  drop line (`.drop-before`, `.drop-after`) in `public/style.css` are part of the
  restyle.

## Open questions

This needs design options shown side by side before a spec, for example glow on the
accents, scanline or grid backgrounds, and a neon palette that passes the
colourblind check. Do it after the header and panel moves, so the new layout is
restyled once.

The Plan usage panel's "Today (share of the week)" bar fills against the 20% daily
budget. The weekly bars above it fill against 100%. Two bars with different scales
in one panel can look like a mistake. The restyle should either fill the Today bar
against 100% or label its scale, for example "bar is out of the 20% budget".
