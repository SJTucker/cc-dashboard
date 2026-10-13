# Measure the earlier-suggestions prompt

Since 2026-10-13, `pendingReviews` in `lib/review.js` sends Haiku an
`EARLIER SUGGESTIONS` section. It lists every suggestion from reviews in the last 14
days, marked open, done, not useful or duplicate. `SYSTEM` tells Haiku not to
propose the same change again, and lets it repeat an open or done one as
`Recurring:`. Check after about two weeks whether this helped.

## Baseline

On 2026-10-13, 107 suggestions from reviews between 2026-10-06 and 2026-10-13 were
triaged by hand: 18 `done`, 56 `not_useful`, 33 `duplicate`. About 30% of all
suggestions repeated a rule, skill or earlier suggestion.

## What to check

- Suggestions per done review, before and after 2026-10-13. A collapse toward zero
  means the section suppresses valid suggestions, not only repeats.
- The share of new suggestions dismissed as `duplicate` and as `not_useful`.
- How many suggestions start with `Recurring:`, and whether they point at real
  repeats.
- Whether the 12,000-character cap drops lines that would have stopped a repeat.
  The cap keeps the newest lines.

## Open questions

- Whether a `Recurring:` suggestion should bump the earlier row instead of adding
  a new one.
- Whether `not_useful` lines should be sent as counts per kind instead of as text,
  if the text makes Haiku avoid whole kinds.
