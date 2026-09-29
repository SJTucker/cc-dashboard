# Reorder the panels

Let the owner change the order of the dashboard's panels from the page, instead of
moving `<section class="panel">` blocks in `public/index.html`. Asked for on
2026-09-29.

## Where the order comes from now

The order is the source order of the sections in `public/index.html`. It runs Plan
usage, Where usage goes, Live sessions, the daily charts, the per-model charts, When
usage happens, Tool calls, the rtk panels, Cost by model beside Model mix, then the
Setup changes panels. Some panels sit in pairs inside a `.panel-row` (Daily cost with
Daily tokens, Cost by model with Model mix). Several panels are `hidden` until their
data exists or until a range shows them.

Recent commits moved panels by editing that file: "move the where usage goes panel
below plan usage" (7af5468). A later change moved Live sessions below Where usage
goes the same way. With this feature, both would be a default-order change plus a
drag.

## Open questions

- **How to move a panel.** A drag handle on each panel head, or up and down buttons.
  Buttons work with the keyboard and need less code. Dragging is quicker for long moves.
- **Where to keep the order.** `localStorage` keeps it per browser, which fits a
  local single-user dashboard. A file under `~/.claude/cc-dashboard/` would survive
  a cleared browser and work across browsers, but it needs a new POST route.
- **Paired panels.** Either a `.panel-row` pair moves as one unit, or each panel
  moves alone and the pairing goes away.
- **Per range.** Today shows panels the other ranges hide, such as Live sessions.
  Either one order applies to every range and hidden panels keep their slot, or each
  range has its own order.
- **Reset.** A "reset layout" control that restores the order in `index.html`.
- **Panel ids.** Each panel needs a stable id for the saved order. Some sections
  have none, for example Daily cost and Cost by model.
- **The restyle.** [cyberpunk-restyle.md](cyberpunk-restyle.md) says to restyle
  once the layout settles. The handles or buttons this adds need to be part of that
  restyle.
