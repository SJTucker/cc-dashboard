# Feed "not useful" dismissals to Haiku

Use the suggestions the user dismissed as "not useful" to change what
`bin/review-session` asks Haiku, so it stops making the same kind of suggestion.
Recorded on 2026-10-08, when dismissal shipped.

## What exists

- Dismissals live in `suggestions.dismissed_at` and `suggestions.reason` in
  `transcripts.db`. `reason` is `done`, `not_useful` or NULL.
- `bin/review-session prompt` sends Haiku the `SYSTEM` text in `lib/review.js` and a
  digest of one session. It sends nothing about earlier reviews.
- Rows are never deleted, so the full history of dismissals is available.

## Open questions

- Which dismissals to send. The last N `not_useful` rows, or the last N per `kind`.
- Whether to send the text of each dismissed suggestion, or only counts per `kind`.
- Where in the prompt they go, and how to word them so Haiku does not skip a
  suggestion that is right for this session.
- How many tokens the extra text may add to each of the up to 3 reviews per run.
- Whether `done` dismissals also help, as examples of suggestions worth making.
- How to tell afterwards whether it worked, for example the share of suggestions
  dismissed as `not_useful` before and after.
