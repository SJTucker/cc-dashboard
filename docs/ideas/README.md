# Ideas

Future work for the dashboard, one file per idea. Each file records what was asked
for, the decisions made so far, and the questions still open.

**When an idea is complete, delete its file and its row in the table below, in the
same change that finishes the work.** The commit that built it is the record from
then on.

| Idea | Status |
|---|---|
| [Better session titles](better-session-titles.md) | Open: branch line and first-prompt fallback shipped; decide around 2026-10-14 whether a model-written title is still needed |
| [Subagent permission prompts](subagent-permission-prompts.md) | Open: a subagent waiting on a permission prompt shows as working; needs a way to read the permission mode first |
| [Before and after chart polish](before-after-chart-polish.md) | Open: empty space under the chart, a change on the last day, axis labels and a legend; chart height and legend form open |
| [Model mix: tokens or cost](model-mix-cost-toggle.md) | Open: click the donut to switch to cost; click target, remembering the choice, sort order and overlap with Cost by model open |
| [Setup changes list follows the range](setup-changes-list-range.md) | Open: the day buttons ignore the range and start at 8/24; filter to the charts' span, consider a timeline or calendar, and decide what a selected change outside the range does |
| [Row store growth](row-store-growth.md) | Open: loaded rows take 47 MB and the All range 75 ms after 40 days; the heap size, aggregate time or stat pass time that starts the work, and daily totals versus loading only the requested range, open |
| [Feed "not useful" dismissals to Haiku](feed-dismissals-to-haiku.md) | Open: which dismissals to send, how to word them, token cost, and how to measure whether it helped |
| [Group Today's sessions by launch](group-sessions-by-launch.md) | Open: sessions after a `/clear` in one `claude` launch show as separate rows; how to link them (a per-process id from the mod, the transcripts, or timing) and how the group row looks, open |
| [Session reviews: action buttons](review-actions-design.md) | Open: Done and Not useful become right-aligned icon buttons with tooltips, Copy prompt gets a tooltip saying what it copies; icons or a menu, and the label, open |
| [All-time session drill-down](all-time-session-drill-down.md) | Open: per-session totals across all time on a new route; columns, paging and where it shows open |
| [Per-project breakdown](per-project-breakdown.md) | Open: usage and cost per project; decoding folder names or using `cwd`, worktrees, and whether estimates are worth showing open |
| [Five-hour window blocks](five-hour-windows.md) | Open: bucket usage into 5-hour windows like `/usage`; how a window starts and where it shows open |
| [Same-week model comparison](same-week-model-comparison.md) | Open: compare two models used in one week; minimum calls, mixed-model prompts and where it shows open |
| [Tool error rate by model](tool-errors-by-model.md) | Open: split the error rate by model and cause; add the model to tool use rows or join through calls open |
| [Cost per unit of work](cost-per-unit-of-work.md) | Open: spend per commit or per Edit and Write call; repository counting and noise open |
