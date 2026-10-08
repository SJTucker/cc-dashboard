# Session reviews: redesign Done / Not useful, explain Copy prompt

Raised on 2026-10-08. The user called the Session reviews action buttons ugly and
asked for two things:

- **A better design for "Done" and "Not useful".**
- **A tooltip on "Copy prompt"** that says what the button does.

## What the code does now

- `openList` in `public/app.js` renders each open suggestion as one `<li>`: the
  kind in bold, the suggestion text, then a `.review-actions` span holding two
  `.refresh-btn` buttons, "Done" and "Not useful". The buttons sit inline after
  the text, so they land wherever the text ends. A long suggestion pushes them to
  the start of the next line. A short one leaves them mid-row.
- Every open suggestion carries both bordered buttons, so a review with five
  suggestions shows ten buttons. The buttons use the same `.refresh-btn` style as
  the panel-level Refresh and Check prices buttons, at 11 px.
- Each button has an `aria-label` (`Mark done: <kind>: <text>`) but no `title`, so
  a mouse user sees no explanation.
- The dismissed list repeats the pattern with one "Undo" button per row.
- "Copy prompt" sits in `.review-source` beside the transcript path. It copies the
  text `reviewPrompt` builds in `public/reviews.js`: the transcript path, the open
  suggestions, and a question asking Claude which suggestions are right and what
  Haiku missed. For a failed review, or one with no suggestions, it asks what
  Claude would suggest instead. Nothing on the page says any of this. The button
  has no `title` and no `aria-label`.

## Proposed design

### Done and Not useful

Move the actions out of the text flow and make them smaller:

1. Each suggestion row becomes a two-column grid: kind and text on the left, the
   actions in a fixed right column aligned to the top of the row. The buttons then
   line up vertically down the list.
2. The two buttons become icon buttons without a border: a check mark for Done and
   a cross (or thumbs-down) for Not useful. The two icons differ in shape, so the
   red-green colourblind rule holds without colour.
3. The buttons show at reduced opacity and go to full opacity on row hover and on
   `:focus-within`, so the keyboard path still shows them.
4. Each button gets a tooltip through the existing `withTooltip` /
   `withFocusTooltip` helpers ("Done: I acted on this", "Not useful: hide it and
   record that Haiku got it wrong"). The `aria-label`s stay.
5. "Undo" in the dismissed list gets the same right-column placement and an
   arrow icon, so both lists look alike.

Alternative, if icons alone are too hard to discover: one small "Dismiss ▾"
button per row that opens a two-item menu (Done, Not useful). This halves the
button count but costs a second click on every dismissal.

### Copy prompt

- Add a tooltip with `withTooltip` and `withFocusTooltip`, and the same text as
  an `aria-description` or `aria-describedby`:
  "Copies a prompt for a new Claude Code session. It gives Claude this transcript
  and the open suggestions, and asks which are right and what Haiku missed."
- The failed and no-suggestion cases get their own sentence, built from the same
  branch `reviewPrompt` uses.
- Consider a clearer label, such as "Copy prompt for Claude" or "Ask Claude".

## Open

- Icons or the "Dismiss ▾" menu. Check icon size against the 11 px row text, and
  whether the reduced opacity is readable in dark mode.
- Whether the tooltip should show the first lines of the actual prompt instead of
  a description.
- Whether the label changes.

## When to build it

After workstream D splits `public/app.js`. D moves `openList`, `dismissedList` and
the review rendering into `public/panels/reviews.mjs`. Building this first would
make D move code twice. Workstream C's Task 8 also changes how list rows mark
selection, so check that its row styles and these do not conflict.
