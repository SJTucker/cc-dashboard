# A `null` transcript line stops every scan

A transcript line that is the JSON value `null` makes `extractFile` in
`lib/extract.js` throw `Cannot read properties of null (reading 'sessionId')` in
`readLine`. `run()` in `lib/rowstore.js` has no catch around the load, so while such
a file exists every scan request fails. Recorded on 2026-10-09 by workstream F's
final review, which reproduced it by running `extractFile` on a one-line file
holding `null`.

## What exists

- Claude Code is not known to write such lines, so the risk is low.
- A line that is not valid JSON is skipped. A valid JSON line that is not an object
  is not.

## Open questions

- Whether `readLine` skips any non-object line, or `run()` catches a failed load and
  keeps the file's previous rows.
- Whether a fix changes extract output, which would need `EXTRACT_VERSION` raised
  and the golden files regenerated with `UPDATE_GOLDEN=1`.
