# Dismiss session review suggestions

Let the user dismiss a suggestion in the Session reviews panel, so the panel shows
only suggestions still worth acting on. Asked for on 2026-10-08.

## What was asked for

- **Dismiss a suggestion.** A suggestion that has been acted on, or is not useful,
  can be removed from view.

## How reviews work today

- `bin/review-session` asks Haiku to review each ended session. `lib/review.js` saves
  one file per session in `<cfg>/cc-dashboard/reviews/<sessionId>.json`, with
  `suggestions: [{ kind, text }]`. `kind` is one of `KINDS`: `claude-md`,
  `skill-or-hook`, `token-waste`, `workflow`.
- `pruneReviews` deletes review files older than 7 days (`KEEP_MS`).
- `GET /api/reviews` returns `readReviews()`. Each review carries its `sessionId`.
- The page draws each suggestion as an `li` in `.review-suggestions` (the reviews
  renderer in `public/app.js`). The panel note counts reviews "with suggestions".
- The Copy prompt button (`reviewPrompt`) copies a prompt that lists every
  suggestion of a review.
- The server's only write endpoints are `POST /api/refresh`, `/api/prices/check` and
  `/api/prices/apply`. A dismiss needs a new one.
- `updateReview(id, fields)` already merges fields into a review file.

## Open questions

- **Where a dismissal is stored.** In the review file (for example
  `dismissed: [<suggestion index>]` written by `updateReview`), so it survives a
  reload and other browsers, and is pruned with the review after 7 days. Or in
  `localStorage`, which needs no endpoint but is lost with site data. A suggestion's
  index is stable, because a review's suggestions do not change after
  `finishReview`.
- **The endpoint.** For example `POST /api/reviews/:sessionId/dismiss` with
  `{ index }`. Validate the id against the reviews directory, so the request cannot
  write outside it.
- **What a dismissed suggestion looks like.** Hidden, with a "1 dismissed" line and
  an undo, or struck through in place.
- **Done or not useful.** Decide whether the user picks a reason. "Not useful"
  dismissals could be added to the prompt in `bin/review-session`, so Haiku stops
  making the same kind of suggestion.
- **Knock-on effects.**
  - Whether Copy prompt leaves out dismissed suggestions.
  - Whether the panel note counts only reviews with suggestions still open.
  - Whether a review whose suggestions are all dismissed collapses or hides.
- **Keyboard access.** The dismiss control needs to be a button that can be reached
  with Tab and has a label naming the suggestion.
