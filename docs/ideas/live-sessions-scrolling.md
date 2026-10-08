# Live sessions: no stray scroll bars, fixed-height tables

The Live sessions panel shows a horizontal and a vertical scroll bar even when both
tables fit. Raised on 2026-10-08.

## What was asked for

- **No visible scroll bars.** The user does not like them.
- **Fixed-height tables.** Give the Running now and Today tables each a fixed height,
  and let each one scroll on its own when it has more rows than fit.

## Why the scroll bars show today

Measured in the browser on 2026-10-08 against the running dashboard:

- `#sessionsPanel` has `overflow-x: auto` (`public/style.css:934`, "Eight columns do
  not fit a narrow window"). Setting `overflow-x` to `auto` makes the browser treat
  `overflow-y` as `auto` too.
- At a 2000 px window, the panel's content is 1 px wider and 1 px taller than the
  panel: `scrollWidth` 1351 against `clientWidth` 1350, `scrollHeight` 687 against
  `clientHeight` 686. Both tables fit inside their `.table-scroll` wrappers
  (1314/1314). So both panel scroll bars appear for 1 px of overflow.
- At a 1000 px window, the Running now table is 1171 px wide in a 914 px
  `.table-scroll` wrapper, so that wrapper scrolls sideways as well. The Doing now
  cell was 487 px wide, holding a long `Bash: cd /private/tmp/...` command with no
  truncation.

## Open questions

- **The 1 px overflow.** Find which element overruns the panel by 1 px, or drop
  `overflow-x: auto` from `#sessionsPanel` and rely on the `.table-scroll` wrappers,
  which already scroll each table sideways.
- **The Doing now column.** Cut the text with an ellipsis and show the whole command
  in a tooltip, so a long command does not widen the Running now table.
- **Table heights.** Pick a fixed height for each table, for example a number of
  rows. Running now usually holds a few sessions. Today grows through the day.
  Decide whether the header row and the Total row stay visible while the rows
  scroll.
- **Hidden scroll bars.** `scrollbar-width: none` hides them in Firefox and recent
  Chrome, and `::-webkit-scrollbar { display: none }` in Safari. A table with hidden
  scroll bars needs another hint that it scrolls, such as a fade at the bottom edge.
  The table also has to scroll with the keyboard.
- **The 5 s Today poll.** `loadAndRender` rebuilds the table bodies on each poll. A
  table the user has scrolled must keep its scroll position across the redraw.
