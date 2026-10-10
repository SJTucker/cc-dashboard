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
| [Row store growth](row-store-growth.md) | Open: loaded rows take 47 MB and the All range 75 ms after 40 days; the heap size, aggregate time or stat pass time that starts the work, and daily totals versus loading only the requested range, open |
| [Feed "not useful" dismissals to Haiku](feed-dismissals-to-haiku.md) | Open: which dismissals to send, how to word them, token cost, and how to measure whether it helped |
| [Plan usage beside Where usage goes](plan-usage-beside-where-usage-goes.md) | Open: which ranges get the shared row, and how both panels lay out at half width |
| [Counts for skills and subagents](skill-and-subagent-counts.md) | Open: what to count (invocations, calls or sessions) and where the count shows |
| [Sticky plan limit banner](sticky-limits-banner.md) | Open: sticky below the header or moved into it, and its height on a narrow screen |
| [Group Today's sessions by launch](group-sessions-by-launch.md) | Open: sessions after a `/clear` in one `claude` launch show as separate rows; how to link them (a per-process id from the mod, the transcripts, or timing) and how the group row looks, open |
| [All-time session drill-down](all-time-session-drill-down.md) | Open: per-session totals across all time on a new route; columns, paging and where it shows open |
| [Per-project breakdown](per-project-breakdown.md) | Open: usage and cost per project; decoding folder names or using `cwd`, worktrees, and whether estimates are worth showing open |
| [Five-hour window blocks](five-hour-windows.md) | Open: bucket usage into 5-hour windows like `/usage`; how a window starts and where it shows open |
| [Same-week model comparison](same-week-model-comparison.md) | Open: compare two models used in one week; minimum calls, mixed-model prompts and where it shows open |
| [Tool error rate by model](tool-errors-by-model.md) | Open: split the error rate by model and cause; add the model to tool use rows or join through calls open |
| [Cost per unit of work](cost-per-unit-of-work.md) | Open: spend per commit or per Edit and Write call; repository counting and noise open |
| [Setup changes: long-history labels](setup-changes-long-history-labels.md) | Open: Monday date labels collide below about 2.3px per day and weekly lane counts below about 3.5px per day; a month-start step and month cells are the possible fix |
| [Horizontal scroll at 400px](narrow-viewport-horizontal-scroll.md) | Open: the page is 416px wide on 30d and All because of `#modelMixPanel`; which element sets the width open |
