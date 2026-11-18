# Claude Code facts

Behaviour of Claude Code that the dashboard and the mod depend on. Each fact was
checked live or in the Claude Code binary on the version named. Recheck a fact after
a Claude Code update before designing around it.

## Transcripts

**One line per content block (checked 2026-09).** In `~/.claude/projects/**/*.jsonl`,
one assistant API response is written as one line per content block (thinking, text,
each `tool_use`). Every one of those lines carries the same copy of the response's
`usage`. On one machine, 66,438 usage lines came from 35,843 requests, a mean of 1.85
lines per request and a maximum of 17. Any token or cost total must dedupe on
`message.id` + `requestId`. Summing lines inflates totals by about 1.7x.

- Claude Code's Stats page (`~/.claude/stats-cache.json`, `modelUsage`) does not
  dedupe, so it reports about 1.7x the real figure. Its `lastComputedDate` also lags.
- `type: "cost-state"` lines carry Claude Code's per-session `totalCostUSD` and
  `modelUsage` counters. They include calls that never get a transcript line
  (session titles, compaction summaries, background Haiku calls), so they run higher
  than any transcript scan. Not every session has one.

**Headless runs (2.1.31x).** `claude -p --no-session-persistence` writes no transcript,
but its usage counts against plan limits. The dashboard cannot see it from
transcripts, so the limit percentage can run ahead of dashboard cost. The installed
mod still loads in those runs and sees `session.start` (`isInteractive: false`),
`session.measure` (rate limits, `cost.usd`), `turn.step` with usage
`{input, output, cache_read, cache_creation, model}` for the main thread, and
`session.end`. `turn.step` usage has no 5m/1h cache-write split and no speed field.

**Messages to a running subagent (2.1.319).** A `SendMessage` to a running background
subagent lands at the subagent's next tool round. It is written to `agent-<id>.jsonl`
as `type: "attachment"`, `attachment.type: "queued_command"`,
`attachment.origin.kind: "coordinator"`, with the text in `attachment.prompt`. A
message sent after the subagent finished resumes it as a `user` record with
`origin.kind: "coordinator"`. `coordinatorText` in `lib/transcript-index.js` handles
both. A resumed subagent can write a second `SubagentHandback` after the first.

## Prompt cache

**Keep-alive touches (2.1.309).** After a main-loop request, Claude Code sends cache
keep-alive requests (source `cache_touch`) on a timer, about every 30 s. Touches
continue while a turn or a subagent is running, and for an activity window after the
last activity. Each touch moves the statusLine `prompt_cache.expires_at`, and none of
them appears in a transcript. So a status line cache countdown stays pinned while a
subagent runs, and that is correct. Transcript-based expiry (`cacheOf` in
`lib/sessions.js`, `bin/cache-state`, the handoff timer) cannot see touches, so it is
a lower bound while a subagent runs.

**Idle compaction (2.1.296).** Idle compaction fires at last activity + 0.9 × cache
TTL (54 min on a 1 h cache). It needs at least 200k context tokens
(`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, floor 100k).

## Rate limits and `session.measure` (2.1.327)

Checked live on 2026-11-18 with the mod's debug log and a watcher on
`rate-limits.json`, and in the binary.

- `session.measure` fires at each main-thread turn end. It also fires mid-turn when
  a rate-limit window's percent moves a whole point. In a live turn, the 5-hour
  reading went 24→29% and each rise produced a `record-statusline` run within about
  60 ms of the API response that carried it.
- Subagent responses feed the same rate-limit state. A rise seen on a subagent's
  response fires the measure even while only the subagent works: 28→29% at 17:36:03,
  2 s after the main turn had ended, 60 ms after a Sonnet subagent's step. In the
  binary, every API response's rate-limit headers update the account's limit state
  unless the request sets `leavesLimitStateAlone` on a model other than the main
  one. Only one-shot helpers, hook prompts and web search set that flag, so
  subagents on any model count.
- The main transcript gets no lines while only a subagent works (no writes for
  100 s in the live run). A reading stamped with the transcript's mtime
  (`recordRateLimits` in `lib/limits.js`) therefore carries the main thread's last
  response time, not the time of the reading. Use the mod's `$.clock.now()` when
  the time of the reading matters.
- `resets_at` of the 5-hour window stayed the same for every reading within one
  window.

## Events a mod never sees (2.1.316)

Claude Code's built-in `cc-plugin-sec-default` sends these events past the `user`
tier, so an installed mod's hook for them never runs:

- `classic.*` (SessionStart, SessionEnd, UserPromptSubmit, ConfigChange and the rest)
- `session.compact`. No mod can replace or observe a compaction, whether manual,
  threshold or idle. `$.session.compact` called by a mod does not raise it either.
- `prompt.section`, `prompt.context`, `prompt.attachment`, `prompt.compose`,
  `skill.prompt`, `attribution.text`, `session.append`, `settings.read`

`claude --debug` logs `<plugin>: session.compact bypassed by cc-plugin-sec-default
(tier user); beneath runs`. Engine events such as `session.measure`, `session.end`,
`turn.complete`, `tool.call` and `command.run` do reach the mod. There is no
`$.session.clear`.

## Mod API

Checked on 2.1.296 unless marked.

- `$.ui.status(text)` and `$.ui.log(text)` return `undefined`. A `.catch` on the
  result throws a TypeError. The test harness returns promises and hides this.
- Only `$.ui.status()` with no argument (or `null`) clears the line.
  `$.ui.status('')` pins an empty `⚠ cc-dashboard:` line in every session. Status text
  renders above the input as `⚠ <plugin>: <text>`. `$.ui.notice` is dropped outside a
  tool call.
- `$.model.fork({ prompt })` takes only a prompt. The engine denies all tools and caps
  it at 2 turns. It reads the main thread's cached context, writes no transcript
  line and raises no turn events. Its `text` joins the reply's text blocks with a
  space.
- `/clear` raises `session.end` with `reason: 'clear'` and no `session.start`. A
  `$.clock.after(4000)` timer set there sees the new session id, and `$.prompt.fill`
  works then. Module state survives a `/clear`.
- At `turn.complete`, the transcript does not yet hold the turn's last assistant
  line. `$.clock.after(0)` does not find it. `$.clock.after(1000)` does.
- `$` may be passed only to a function declared at the top level of the same file.
  Passing it to an imported function stops the hooks module from loading, and
  `claude plugin validate` refuses it. A helper shared between files takes plain
  values.
- An event can have only one `on(...)` hook per mod without a matcher. A second
  `on('session.measure', ...)`, even from another file, stops the module loading
  (`registered twice without a matcher`). Add work to the existing handler. With the
  `$` rule, all `$` code for one event lives in `mod/hooks/register.ts`.
- `$.process.run` is refused when an argv string or the stdin string names a Claude
  Code settings file (`settings.json` or `settings.local.json` resolving to a Claude
  Code one). `$.fs.write` is checked only by its target path, so the mod passes free
  text to a script as a file named by `--input` (2.1.327).
- `$.fs.write` creates missing parent folders. `$.process.run` accepts `{ cwd }`.
- `$.session.model()` returns the model id (for example `claude-opus-5-5[1m]`), not
  the display name (2.1.316).
- `$.session.root()` follows a worktree move, but the transcript stays in the
  original project's folder (2.1.316).
- `/handoff` is taken by the grill plugin, so `$.command.register({ name: 'handoff' })`
  is refused. The mod uses `/transcript-handoff` (2.1.316).
- `$.session.send({ to: { agentId }, text })` resolves `{ isDelivered: true }` and
  reaches a running background subagent at its next tool round, as an `attachment`
  of type `queued_command` with `origin: { kind: "coordinator", plugin: "<mod name>" }`.
  It does not interrupt a running Bash call (2.1.322). The Orchestration tab's steer
  relay uses this.
- `$.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })`
  resolves `{ message, uuid }` and writes a `type: "user"` row with `isMeta: true` into
  the main transcript. Parsers that read user prompts must handle `isMeta` (2.1.322).
- A background subagent's `tool.call` reaches the mod. The orchestrate worktree guard
  in `mod/hooks/guard.ts` refused an outside `Write` from one live (2.1.323).
