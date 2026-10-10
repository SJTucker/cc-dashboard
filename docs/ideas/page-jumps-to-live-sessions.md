# Page jumps to the Live sessions panel on update

Find out why the page scrolls to the Live sessions panel when the page updates, and
stop it. Asked for on 2026-10-10.

## What was asked for

- **An investigation first.** The page jumps to the Live sessions panel
  (`<h2>Live sessions</h2>` in `public/index.html`) when it updates. The cause is not
  known yet.

## Leads, not yet checked

- **Focus restore in `renderSessions`.** `public/panels/sessions.mjs` rebuilds
  `#sessionsTable` with `replaceChildren` on each render. If a group toggle had focus,
  it calls `toggles.get(focused[0])?.focus()` afterwards. `focus()` with no options
  scrolls the element into view. A toggle keeps focus after a mouse click, so after
  one click on a project group, every 5 s Today poll could scroll the page back to
  that toggle. `focus({ preventScroll: true })` keeps the focus without the scroll.
- **The same pattern in reviews.** `public/panels/reviews.mjs` restores focus to a
  `[data-review-focus]` button after it rebuilds the review list, also with a bare
  `focus()`.
- **Height changes.** The tables are replaced on each render. If a table above the
  viewport changes height, the content below it moves. Commit `f199e13` capped each
  `.table-scroll` at 20rem, which limits how far a table can grow.

## Open questions

- **How to reproduce it.** Does the jump happen only after clicking something in the
  Live sessions panel, or on a page that has had no clicks? Which range, and does it
  follow every 5 s poll or only some?
- **Which element is focused** when the jump happens: read `document.activeElement`
  with `playwright-cli` before and after a poll.
