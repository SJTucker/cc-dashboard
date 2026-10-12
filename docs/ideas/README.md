# Ideas

Future work for the dashboard, one file per idea. Each file records what was asked
for, the decisions made so far, and the questions still open.

**When an idea is complete, delete its file and its row in the table below, in the
same change that finishes the work.** The commit that built it is the record from
then on.

| Idea | Status |
|---|---|
| [Better session titles](better-session-titles.md) | Open: branch line and first-prompt fallback shipped; decide around 2026-10-14 whether a model-written title is still needed |
| [Subagent permission prompts](subagent-permission-prompts.md) | Parked 2026-10-11: sessions here run in `auto`, where no dialog opens; findings on reading a subagent's mode at spawn recorded |
| [Row store growth](row-store-growth.md) | Open: compaction cut loaded rows from 61 MB to 37 MB over 44 days; the thresholds that start a per-call column store (All aggregate above 500 ms, row heap above 400 MB, stat pass above 100 ms) are recorded, and nothing else is built yet |
| [Feed "not useful" dismissals to Haiku](feed-dismissals-to-haiku.md) | Open: which dismissals to send, how to word them, token cost, and how to measure whether it helped |
| [Same-week model comparison](same-week-model-comparison.md) | Open: compare two models used in one week; minimum calls, mixed-model prompts and where it shows open |
| [Setup changes: long-history labels](setup-changes-long-history-labels.md) | Open: Monday date labels collide below about 2.3px per day and weekly lane counts below about 3.5px per day; a month-start step and month cells are the possible fix |
| [Horizontal scroll at 400px](narrow-viewport-horizontal-scroll.md) | Open: the page is 416px wide on 30d and All because of `#modelMixPanel`; which element sets the width open |
| [Where the time goes](turn-durations.md) | Open: read the unused `turn_duration` lines for model hours per day and turn length; subagent coverage and tool time open |
| [Plan limit warning inside Claude Code](limit-warning-in-claude-code.md) | Open: the mod shows a dismissable toast or band when a window passes 75%; what a dismissal covers, repeat rule and shared warned state open |
| [What fills the context](context-fillers.md) | Open: largest tool results and repeated reads across the range; result size storage and grouping open |
| [Cost by plugin](plugin-cost-rows.md) | Open: a Plugins list in Where usage goes from the unused `attributionPlugin` field, and MCP servers from `attributionMcpServer`; invocation counts and subagent calls open |
| [Costliest prompts](costliest-prompts.md) | Open: rank prompts by cost with a drill-down; storing prompt text open |
| [Thinking tokens](thinking-tokens.md) | Open: show the share of output that is thinking, from the stored `thinking_tokens` field; why some calls lack it and where it shows open |
| [Guard: rows when a transcript loses lines](transcript-rewrites.md) | Open: the rewrite report was not reproduced on Claude Code 2.1.296; a warning when a re-read file loses stored call keys, and whether to merge rows, open |
| [Today table: group by /clear link](today-table-clear-chains.md) | Open: `launchId` grouping misses a session resumed in a new process and then cleared; join on `clearedFrom` as well or instead open |
