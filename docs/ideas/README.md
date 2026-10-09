# Ideas

Future work for the dashboard, one file per idea. Each file records what was asked
for, the decisions made so far, and the questions still open.

**When an idea is complete, delete its file and its row in the table below, in the
same change that finishes the work.** The commit that built it is the record from
then on.

| Idea | Status |
|---|---|
| [Setup script](setup-script.md) | Next, toward shipping: one command from clone to working dashboard and mod; language, what it changes, re-runs, launchd and uninstall open |
| [Docker](docker.md) | Next, toward shipping: test SQLite WAL across the container boundary first; binding, mounts and whether it saves a step open |
| [Better session titles](better-session-titles.md) | Open: branch line and first-prompt fallback shipped; decide around 2026-10-14 whether a model-written title is still needed |
| [Subagent permission prompts](subagent-permission-prompts.md) | Open: a subagent waiting on a permission prompt shows as working; needs a way to read the permission mode first |
| [Before and after chart polish](before-after-chart-polish.md) | Open: empty space under the chart, a change on the last day, axis labels and a legend; chart height and legend form open |
| [Model mix: tokens or cost](model-mix-cost-toggle.md) | Open: click the donut to switch to cost; click target, remembering the choice, sort order and overlap with Cost by model open |
| [Setup changes list follows the range](setup-changes-list-range.md) | Open: the day buttons ignore the range and start at 8/24; filter to the charts' span, consider a timeline or calendar, and decide what a selected change outside the range does |
| [Row store growth](row-store-growth.md) | Open: loaded rows take 47 MB and the All range 75 ms after 40 days; the heap size or aggregate time that starts the work, and daily totals versus loading only the requested range, open |
| [Feed "not useful" dismissals to Haiku](feed-dismissals-to-haiku.md) | Open: which dismissals to send, how to word them, token cost, and how to measure whether it helped |
| [Group Today's sessions by launch](group-sessions-by-launch.md) | Open: sessions after a `/clear` in one `claude` launch show as separate rows; how to link them (a per-process id from the mod, the transcripts, or timing) and how the group row looks, open |
| [Session reviews: action buttons](review-actions-design.md) | Open: Done and Not useful become right-aligned icon buttons with tooltips, Copy prompt gets a tooltip saying what it copies; icons or a menu, and the label, open. Build after D |
