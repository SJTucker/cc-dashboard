# Rethink the Live sessions panel

Rework the Live sessions panel (`#sessionsPanel`, drawn by `renderSessions` in
`public/app.js`) around three questions, and give each session a descriptive title.
Asked for on 2026-10-06.

## What the panel is for

The user wants a glance at the panel to answer:

- **What is running right now.**
- **Where today's money went.**
- **What did I work on today.**

Spotting a session that is going badly was not picked as a goal.

## What is wrong now

- **Rows look alike.** Rows are named by `project`, the basename of the project
  folder. Several sessions in one project with different purposes all show the same
  name.
- **The table does not feel right.** The user could not name one cause. They suspect a
  different form would serve the three questions better.

## Chosen direction

The user liked two of the three directions offered. The two can be built together in
one panel, or as two separate panels, each built on its own:

- **A day timeline strip.** One lane per session, with a bar from its first
  call to its last activity, similar to Grafana's state timeline. A running session's
  bar stays open at "now". It shows when each session ran and which ones overlapped.
  When it shares a panel with the list, hovering a bar highlights its row.
- **A title-first list.** Two groups:
  - **Running now**, pinned on top. Each row shows the title, a small project tag,
    what the session is doing now, the count of open subagents, and cost.
  - **Today**, sorted by cost. Each row shows the title, project tag, length, lines
    and cost, with an inline bar scaled to the day's largest session. The bar needs a
    texture and a label, not colour alone, because the user is red-green
    colourblind.

Project cards, one card per project, were the third option and were not picked.

## Session titles

- **Claude Code already writes one.** Each transcript has `ai-title` lines, for
  example `{"type":"ai-title","aiTitle":"Ideas and planning","sessionId":"…"}`. One
  session can hold dozens of these lines, so read the last one. Today's titles are
  specific, for example "PR 4 handoff and task 7 review" and "c17 PR split handoff".
- **A rename may override it.** A `custom-title` line is expected after `/rename`.
  None was found in today's transcripts, so its exact shape is unconfirmed.
- **Some sessions have none.** One cc-dashboard session today had no `ai-title`.
- **The user's alternative: a Haiku agent.** When a session starts, a Haiku call reads
  the first two prompts and writes a short title. The mod already runs Haiku for
  session reviews (`bin/review-session`), so the same path could write titles. Using
  `ai-title` first and Haiku only for sessions without one avoids a model call per
  session.
- **Where to read titles.** The Today scan in `lib/scan.js` reads every transcript
  line. It can keep the last `ai-title` per session id beside `linesBySession`, and
  `buildLiveSessions` in `lib/sessions.js` can join it the way it joins lines.

## What other tools show

Research done on 2026-10-06. Layout claims come from READMEs and docs, not
screenshots.

- **ccmanager** (github.com/kbwo/ccmanager) leads with three states: Waiting (asking
  for input), Busy and Idle. Its multi-project view counts each state per project.
- **ccboard** (docs.rs/ccboard) marks running, waiting for input and done with glyphs.
  It shows lines added and removed, a subagent tree and an optional AI summary per
  session.
- **claude-view** (github.com/tombelieber/claude-view) shows a card per session with
  the latest message, cost, context-window percentage and a prompt-cache countdown.
- **The Claude Code desktop sidebar** groups sessions by project and archives
  finished ones, so the list shows what is live.
- **Grafana's state timeline** draws one horizontal lane per series with bars for each
  state. That is the model for the timeline strip.

## Open questions

- **One panel or two.** Separate panels let each be built, hidden and moved on its
  own, and the timeline could then show on ranges other than Today. One panel lets a
  hover link a bar to its row. Both depend on session titles, so titles come first
  either way.
- **"Waiting on me".** Every tool above leads with whether a session is waiting for
  the user. The mod only receives Claude Code's engine events. `Notification` and
  `Stop` are classic hook events, which an installed mod cannot see. Check which
  engine event, if any, marks the end of a turn. Otherwise a settings hook is needed,
  as in the setup-changes idea.
- **"Doing now" and subagents.** The mod sees `tool.call`. It could write the current
  tool and the count of open Task calls into the session snapshot that
  `bin/record-statusline` keeps. Decide how stale that may get before it is hidden.
- **Timeline lanes.** One lane per session, or per project with sessions as bars.
  Short sessions need a minimum bar width and a hit target. Long idle gaps inside a
  session could show as a thinner bar.
- **The project roll-up.** The roll-up of cleared and ended sessions
  (`groupSessions` in `public/session-groups.js`) was built on 2026-10-06. Titles make
  rows distinct, so decide whether the roll-up stays.
- **Rows moving.** Sorting Today by cost reorders rows as costs grow on every 5 s
  poll. Decide whether to sort only when a session ends.
- **Prompt count.** [Prompts per session](session-prompt-count.md) adds a figure to
  each row. Fold it into this design or keep it separate.
- **Other ranges.** The panel shows on Today only. Decide whether the timeline should
  show on other ranges, one day at a time.
