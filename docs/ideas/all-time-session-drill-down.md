# All-time session drill-down

A route such as `/api/sessions/history` that returns per-session totals across all
time, so a past session can be looked up. Moved from README "Extending it" on
2026-10-09.

## What exists

- `/api/sessions/live` in `server.js` covers today's sessions only. A new route needs
  a different name.
- `extractFile` in `lib/extract.js` returns per-session summaries for each transcript,
  and `lib/rowstore.js` keeps them in memory per file.
- `aggregate` in `lib/aggregate.js` collects titles, branches, first prompts and edit
  lines per session into `efficiency`. `server.js` strips `efficiency` from
  `/api/summary`. Nothing computes cost or tokens per session across all time.

## Open questions

- Which columns a row shows: cost, tokens, prompts, duration, project, branch.
- Whether the list pages or searches, given about 1,400 transcripts in 40 days.
- Where it lives on the page: a new panel, or a link from the Session reviews panel.
