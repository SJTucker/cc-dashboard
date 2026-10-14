# Cache efficiency bar in Where usage goes

Asked for on 2026-10-14: add a cache efficiency bar to the Where usage goes panel
(`#attributionPanel`, `public/panels/attribution.mjs`), next to the Main thread vs
subagents and Context size bars.

## Already in place

- The panel's two bars split total cost: main thread against subagents, and calls
  under against over 150k context (`LARGE_CONTEXT_TOKENS` in `lib/aggregate.js`).
  The panel's note says "share of total cost".
- `lib/efficiency.js` computes `cacheHit` as cache read tokens over all prompt
  tokens. The Setup changes panel charts it per day as "Cache hit rate".

## Also asked for

- Make the striped "Over 150k context" segment of the Context size bar dimmer. The
  stripes still tell the two segments apart; the dimmer fill makes the solid "Under
  150k" segment stand out.

## Open questions

- What the bar splits. Two candidates:
  - Tokens: cache reads against cache writes against uncached input. This matches
    `cacheHit`, but it is a token share where the panel's other bars are cost shares.
  - Cost: what cache reads, cache writes, uncached input and output each cost. This
    matches the panel's "share of total cost" note.
- Whether to show the cost the cache saved, which is reads priced at the input rate
  minus what they cost.
- Fill textures for three or four segments that stay distinguishable without
  colour.
