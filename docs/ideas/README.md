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
| [Dismiss review suggestions](dismiss-review-suggestions.md) | Open: where a dismissal is stored, the endpoint, how a dismissed suggestion shows, and whether a reason feeds back to Haiku |
| [Model mix: tokens or cost](model-mix-cost-toggle.md) | Open: click the donut to switch to cost; click target, remembering the choice, sort order and overlap with Cost by model open |
| [Setup changes list follows the range](setup-changes-list-range.md) | Open: the day buttons ignore the range and start at 8/24; filter to the charts' span, consider a timeline or calendar, and decide what a selected change outside the range does |
| [Row store growth](row-store-growth.md) | Open: loaded rows take 47 MB and the All range 75 ms after 40 days; the heap size or aggregate time that starts the work, and daily totals versus loading only the requested range, open |
