# Summary cards in the sticky header

Two changes to the top of the page.

1. Move the row of summary cards up beside the range tabs (Today / 7D / 30D / 90D /
   All and the live dot), inside the sticky header, so the cards stay visible while
   scrolling. The header is already sticky: `.topbar` in `public/style.css` has
   `position: sticky; top: 0`.
2. Remove the subtitle under the title: "Local & offline — reads ~/.claude/projects
   and, if present, rtk's command history, nothing leaves this machine." The subtitle
   is `p.subtitle` in `public/index.html`. `public/app.js` writes the projects path into
   its `#projectsDirLabel`, and that line goes too. The "No Claude Code project logs
   found at …" banner still names the path, so the path stays visible when it matters.

## Open questions

- The cards are tall today: label, value, and a two-line note on some. They need a
  compact form to fit beside the tabs. Which notes stay, and do any move into a
  tooltip?
- There are up to nine cards (Total cost, Total tokens, Claude Code reported, Cache
  efficiency, Cost per day, 30 days at this rate, Session files on disk, Record day,
  Tool calls). A sticky header that holds all nine takes a lot of vertical space.
  Which ones earn a place in the header?
- Narrow screens: the only header media query today is at 720px. The cards could
  wrap below the tabs, or scroll sideways.
