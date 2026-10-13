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
| [Where the time goes](turn-durations.md) | Open: read the unused `turn_duration` lines for model hours per day and turn length; subagent coverage and tool time open |
| [What fills the context](context-fillers.md) | Open: largest tool results and repeated reads across the range; result size storage and grouping open |
| [Cost by plugin](plugin-cost-rows.md) | Open: a Plugins list in Where usage goes from the unused `attributionPlugin` field, and MCP servers from `attributionMcpServer`; invocation counts and subagent calls open |
| [Costliest prompts](costliest-prompts.md) | Open: rank prompts by cost with a drill-down; storing prompt text open |
| [Guard: rows when a transcript loses lines](transcript-rewrites.md) | Open: the rewrite report was not reproduced on Claude Code 2.1.296; a warning when a re-read file loses stored call keys, and whether to merge rows, open |
| [File line limit](file-line-limit.md) | Open: a line limit for source files and splits of the largest, most read and edited files first; the limit, enforcement and how to count reads open |
| [Today table: group by /clear link](today-table-clear-chains.md) | Open: `launchId` grouping misses a session resumed in a new process and then cleared; join on `clearedFrom` as well or instead open |
| [Session timeline: live sessions above a divider](timeline-live-section.md) | Open: live lanes on top and the rest below a divider; the buffer that stops lanes jumping, /clear chains that span both sections, and which live rule to use open |
| [Subagent output is undercounted](subagent-output-undercount.md) | Open: confirmed in interactive sessions since Claude Code 2.1.280 (27,134 subagent responses with no final usage line); a mod `turn.step` hook sees the real usage, and a join on `agentId` plus input-side counts is designed, not built |
| [Plan limit band below the prompt](limit-band-below-prompt.md) | Open: no mod render slot sits between the prompt and the status line; a `bin/limit-line` in the statusline script is the likely route; dismissing and shared band logic open |
