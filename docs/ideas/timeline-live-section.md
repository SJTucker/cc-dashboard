# Session timeline: live sessions above a divider

Split the Session timeline's lanes into two sections, live sessions on top and
sessions that are not live below, with a divider between them. A session moves to
the other section when it starts or stops being live, with a buffer so lanes do not
jump back and forth. Asked for on 2026-10-13.

## What exists

- `laneLayout` in `public/chart-geometry.mjs` orders lanes by first span start
  (`byStart`). A session started by `/clear` sits directly under the session it
  cleared (`clearParents`), drawn with ↳ and a curve.
- A session is live when it has not ended and its last call is within
  `LIVE_WINDOW_MS` (10 minutes, `lib/sessions.js`). Each row of
  `/api/sessions/live` carries `live`.
- On 2026-10-13, 17 sessions were shown with 6 live, spread through the list. The
  live ones were hard to find among the striped lanes.
- The Live sessions panel already splits its rows into Running now and Today
  (`runningSessions` in `public/session-groups.mjs`). That split keeps a session that is
  waiting on the user in Running now after its live window ends.

## Open questions

- **The buffer.** Candidates:
  - a session moves down only after it has been not live for some minutes, and
    moves up at once;
  - the same delay in both directions;
  - a section change applies only on a full redraw, not on every 5-second poll.
  The delay length is open. The page keeps no state between polls today, so the
  page has to remember when each session last changed section.
- **/clear chains.** A chain whose parent has ended but whose child is live: does
  the whole chain move up, or does the child move up alone and lose the ↳ link?
- **Which rule decides "live".** Use the timeline's own `live`, or the Running now
  rule, which also keeps sessions waiting on the user. Using the Running now rule
  would make the timeline and the Live sessions table agree.
- **Order inside each section.** Keep first span start, or put the most recently
  active first in the live section.
- **The divider.** A labelled rule ("Live · 6" / "Earlier · 11"), or a gap with no
  label. It goes into the timeline legend from the design pass if it needs
  explaining.
