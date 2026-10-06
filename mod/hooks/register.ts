import type { EngineInterface, Register, SessionMeasureInput, SessionRateLimit } from 'claude-code'

// Records the dashboard's plan usage and session snapshots by running the scripts
// in bin/ that a statusline script used to run, and judges new Claude Code releases
// for the setup changes markers through bin/judge-updates, and reviews ended sessions
// for setup suggestions through bin/review-session.
// The scripts are the only writers of those files, so the file formats, the atomic
// writes and the freshness checks are theirs. The activity files are the one
// exception: the mod writes them itself with $.fs.write, because one writer per
// session keeps a session's states in order, where a script started per event can
// finish out of order.
//
// Only engine events are hooked. Claude Code's cc-plugin-sec-default skips every
// classic.* hook of an installed plugin, so classic SessionStart and SessionEnd
// never reach this module.

const MEASURE_TIMEOUT_MS = 5000
// session.end has 1.5 s for every hook and core together.
const END_TIMEOUT_MS = 1200
const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
const RELEASE = /^\d+\.\d+\.\d+$/
// prompt reads every transcript to list versions, so it gets longer than record.
const PROMPT_TIMEOUT_MS = 120_000
const RECORD_TIMEOUT_MS = 10_000
// review-session prompt reads up to three transcripts in full.
const REVIEW_PROMPT_TIMEOUT_MS = 60_000
const MODEL_TIMEOUT_MS = 60_000
const RETRY_MS = 60 * 60 * 1000

type Frozen<T> = { readonly [K in keyof T]: T[K] }
type Window = { used_percentage: number; resets_at?: number }

// `claude plugin validate` refuses a function that takes $ unless it is declared at
// the top of the file, so these flags are module variables. A reload starts them
// over, which costs one more fs.stat or one more log line.
let binDir: string | undefined
let hasLogged = false

function fail($: EngineInterface, text: string) {
  if (hasLogged) return
  hasLogged = true
  $.ui.log(text)
}

// mod/ is symlinked into ~/.claude/skills/, so $.plugin.root is the link's path.
// The real path's parent is the repo, which holds bin/.
async function scriptPath($: EngineInterface, name: string) {
  if (binDir === undefined) {
    const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
    binDir = `${(realPath ?? $.plugin.root).replace(/\/[^/]+\/?$/, '')}/bin`
  }
  return `${binDir}/${name}`
}

async function run($: EngineInterface, name: string, input: object, timeoutMs: number) {
  try {
    const { exitCode } = await $.process.run([await scriptPath($, name)], {
      stdin: JSON.stringify(input),
      timeoutMs,
    })
    if (exitCode !== 0) fail($, `${name} failed (exit ${exitCode})`)
  } catch (err) {
    fail($, `${name} failed (${err instanceof Error ? err.name : 'error'})`)
  }
}

// Transcript paths found so far, by session id. A transcript does not move, so a
// cached path is not checked again.
const transcripts = new Map<string, string>()

// <config dir> is CLAUDE_CONFIG_DIR with a leading ~ expanded, else ~/.claude.
// Null when neither variable is set.
async function configDir($: EngineInterface) {
  const configEnv = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  if (!configEnv && !home) return null
  return configEnv ? configEnv.replace(/^~(?=\/|$)/, home ?? '~') : `${home}/.claude`
}

// No $ call returns the transcript's path. Claude Code keeps it at
// <config dir>/projects/<folder>/<session id>.jsonl, where <folder> is the directory
// the session started in, every character outside a-z, A-Z and 0-9 replaced by '-'.
// Claude Code shortens and hashes a very long folder name. $.session.root() follows
// /cd and a worktree move, so the folder built from it can be the wrong one.
// The built path is the first guess. On a miss every folder under projects/ is
// searched for <session id>.jsonl. Null when neither variable is set or no file is
// found.
async function transcriptPath($: EngineInterface, root: string, id: string) {
  const cached = transcripts.get(id)
  if (cached) return cached
  const dir = await configDir($)
  if (!dir) return null
  const projects = `${dir}/projects`
  const folder = root.replace(/[^a-zA-Z0-9]/g, '-')
  const built = `${projects}/${folder}/${id}.jsonl`
  let found: string | null = (await $.fs.exists(built)) ? built : null
  if (!found) {
    const entries = await $.fs.list(projects).catch(() => [])
    for (const entry of entries) {
      if (entry.kind === 'file' || entry.name === folder) continue
      const candidate = `${projects}/${entry.name}/${id}.jsonl`
      if (await $.fs.exists(candidate)) {
        found = candidate
        break
      }
    }
  }
  if (found) transcripts.set(id, found)
  return found
}

// $.session.model() returns the model id, and the statusline sent a display name,
// which the Live sessions panel shows: claude-opus-5-5[1m] is "Opus 5.5 (1M
// context)" and claude-haiku-4-5-20251001 is "Haiku 4.5". Any other form is sent
// as it is.
function displayName(id: string) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!match) return id
  const [, family = '', version = '', oneMillion] = match
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replace(/-/g, '.')}`
  return oneMillion ? `${name} (1M context)` : name
}

// The statusline sends resets_at as epoch seconds, and lib/limits.js reads it that
// way. session.measure sends an ISO timestamp.
function toWindow(limit: Frozen<SessionRateLimit>): Window {
  const ms = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return Number.isNaN(ms)
    ? { used_percentage: limit.percentUsed }
    : { used_percentage: limit.percentUsed, resets_at: Math.floor(ms / 1000) }
}

// Only the two windows the statusline JSON has. A gateway's spend_limit is left out.
function rateLimitsInput(limits: readonly Frozen<SessionRateLimit>[]): Record<string, Window> | undefined {
  const out: Record<string, Window> = {}
  for (const limit of limits) {
    if (limit.kind === 'five_hour' || limit.kind === 'seven_day') out[limit.kind] = toWindow(limit)
  }
  return Object.keys(out).length ? out : undefined
}

// The JSON a statusLine command receives, cut to the fields bin/record-statusline
// reads. API duration and line counts are left out: no mod event has them, and
// recordSession stores them as 0. Null when there is nothing to record.
async function statuslineInput($: EngineInterface, e: Frozen<SessionMeasureInput>) {
  const rateLimits = rateLimitsInput(e.rateLimits)
  if (!e.cost && !rateLimits) return null
  // Read on every measure, because a /clear moves the process to a new session id
  // and no session.start fires for it.
  const id = await $.session.id()
  const root = await $.session.root()
  const transcript = await transcriptPath($, root, id)
  if (!transcript) {
    // The first measure can arrive before Claude Code has written the transcript.
    // Without cost there is no session to record yet, and the next measure retries.
    if (e.cost) fail($, 'transcript not found')
    return null
  }
  const input: Record<string, unknown> = {
    session_id: id,
    transcript_path: transcript,
    workspace: { project_dir: root },
    model: { display_name: displayName(await $.session.model()) },
  }
  if (e.cost) {
    const { startedAt } = await $.session.usage()
    input.cost = { total_cost_usd: e.cost.usd, total_duration_ms: Math.max(0, (await $.clock.now()) - startedAt) }
  }
  if (rateLimits) input.rate_limits = rateLimits
  return input
}

type Batch = { versions: string[]; system: string; prompt: string }
type Judged = { asked: number; recorded: number; relevant: number; failed: string[] }
type Review = { sessionId: string; system: string; prompt: string }

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'error')

// Every update failure is logged. They happen at most once per Claude Code release,
// so the once-only rule in fail() would hide the one that matters.
function note($: EngineInterface, text: string) {
  $.ui.log(text)
}

// Runs a bin/ script that prints one JSON object, and throws with the first line of
// its stderr when it exits non-zero.
async function callScript($: EngineInterface, name: string, args: string[], stdin: string, timeoutMs: number): Promise<unknown> {
  const { exitCode, stdout, stderr } = await $.process.run([await scriptPath($, name), ...args], { stdin, timeoutMs })
  if (exitCode !== 0) throw new Error(`${name} ${args[0]} failed (exit ${exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`)
  // A JSON.parse error message can quote the start of its input, which here may be
  // transcript text, so the message is replaced.
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${name} ${args[0]} printed invalid JSON`)
  }
}

const versionSpan = (versions: string[]) =>
  versions.length > 1 ? `${versions[0]}–${versions[versions.length - 1]}` : (versions[0] ?? '')

// Asks Haiku about one batch and records the answer, adding any failure to `judged`.
async function judgeBatch($: EngineInterface, batch: Batch, judged: Judged) {
  judged.asked += batch.versions.length
  let reply: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    reply = await $.model.complete({
      model: 'haiku',
      system: batch.system,
      prompt: batch.prompt,
      maxTokens: 2048,
      effort: 'low',
      timeoutMs: MODEL_TIMEOUT_MS,
    })
  } catch (err) {
    judged.failed.push(`Haiku call failed for ${versionSpan(batch.versions)} (${errorName(err)})`)
    return
  }
  if (!reply.isAnswered) {
    judged.failed.push(`Haiku gave no verdict for ${versionSpan(batch.versions)} (${reply.reason})`)
    return
  }
  try {
    const input = JSON.stringify({ versions: batch.versions, reply: reply.text })
    const out = (await callScript($, 'judge-updates', ['record'], input, RECORD_TIMEOUT_MS)) as { recorded: number; relevant: number }
    judged.recorded += out.recorded
    judged.relevant += out.relevant
  } catch (err) {
    judged.failed.push(err instanceof Error ? err.message : 'judge-updates record failed')
  }
}

// Fetches the changelog, has bin/judge-updates list what needs a verdict, asks
// Haiku once per batch, and has bin/judge-updates record each answer. With
// `current`, the running version is judged even before a transcript has it.
async function judgeUpdates($: EngineInterface, current?: string): Promise<Judged> {
  const judged: Judged = { asked: 0, recorded: 0, relevant: 0, failed: [] }
  let changelog: string
  try {
    const res = await $.http.fetch(CHANGELOG_URL)
    if (!res.ok) {
      judged.failed.push(`changelog fetch returned ${res.status}`)
      return judged
    }
    changelog = res.text
  } catch (err) {
    judged.failed.push(`changelog fetch failed (${errorName(err)})`)
    return judged
  }
  let batches: Batch[]
  try {
    const args = current ? ['prompt', '--current', current] : ['prompt']
    batches = ((await callScript($, 'judge-updates', args, changelog, PROMPT_TIMEOUT_MS)) as { batches: Batch[] }).batches
    if (!Array.isArray(batches)) {
      judged.failed.push('judge-updates prompt printed no batches')
      return judged
    }
  } catch (err) {
    judged.failed.push(err instanceof Error ? err.message : 'judge-updates prompt failed')
    return judged
  }
  for (const batch of batches) await judgeBatch($, batch, judged)
  return judged
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'error')

// Asks Haiku to review one ended session and has bin/review-session record the
// answer. A call with no answer is recorded as failed, so the session is tried
// again after an hour.
async function reviewSession($: EngineInterface, review: Review) {
  let outcome: { reply: string } | { error: string }
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: review.system,
      prompt: review.prompt,
      maxTokens: 1024,
      effort: 'low',
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    if (reply.isAnswered) {
      outcome = { reply: reply.text }
    } else {
      const status = reply.reason === 'api-error' && reply.status !== null ? ` ${reply.status}` : ''
      outcome = { error: `Haiku gave no answer (${reply.reason}${status})` }
    }
  } catch (err) {
    outcome = { error: `Haiku call failed (${errorName(err)})` }
  }
  await callScript($, 'review-session', ['record'], JSON.stringify({ sessionId: review.sessionId, ...outcome }), RECORD_TIMEOUT_MS)
}

// Reviews each ended session bin/review-session hands back. A failed review is
// logged and the rest still run.
async function reviewSessions($: EngineInterface) {
  const { reviews } = (await callScript($, 'review-session', ['prompt'], '', REVIEW_PROMPT_TIMEOUT_MS)) as { reviews?: unknown }
  if (!Array.isArray(reviews)) throw new Error('review-session prompt printed no reviews')
  for (const review of reviews as Review[]) {
    await reviewSession($, review).catch((err) => note($, `session review failed (${errorText(err)})`))
  }
}

// From a timer, so the hook that calls it returns first.
function startReviews($: EngineInterface) {
  $.clock.after(0, () => {
    reviewSessions($).catch((err) => note($, `session review failed (${errorText(err)})`))
  })
}

// Where the verdicts live, as lib/updates.js getUpdatesPath finds them:
// UPDATES_FILE with a leading ~ expanded, else <config dir>/cc-dashboard/updates.json.
// Null when no path can be built.
async function updatesPath($: EngineInterface) {
  const override = await $.env.get('UPDATES_FILE')
  if (override) return override.replace(/^~(?=\/|$)/, (await $.env.get('HOME')) ?? '~')
  const dir = await configDir($)
  return dir ? `${dir}/cc-dashboard/updates.json` : null
}

// Runs once per session start, after the session is up. Only the running version
// is looked up here; /backfill-updates covers the versions before it.
async function checkVersion($: EngineInterface) {
  const { base } = await $.session.version()
  if (!base || !RELEASE.test(base)) return // a dev build has no changelog entry
  const file = await updatesPath($)
  if (!file) return
  // A read that fails means no verdicts yet: the file is written on the first one.
  const text = await $.fs.read(file).then(String, () => undefined)
  let verdicts: Record<string, unknown> = {}
  if (text !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      note($, `${file} is not valid JSON; fix or delete it`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      note($, `${file} is not a JSON object; fix or delete it`)
      return
    }
    verdicts = parsed as Record<string, unknown>
  }
  if (Object.hasOwn(verdicts, base)) return
  // On release day the changelog has no entry for the running version yet, so each
  // session start would download the whole changelog again. One attempt per version
  // per hour is enough. /backfill-updates does not apply this limit.
  const now = await $.clock.now()
  const last = (await $.store.get('updateCheck')) as { version?: unknown; at?: unknown } | undefined
  if (last?.version === base && typeof last.at === 'number' && now - last.at < RETRY_MS) return
  await $.store.set('updateCheck', { version: base, at: now })
  const judged = await judgeUpdates($, base)
  for (const failure of judged.failed) note($, failure)
}

function backfillText(judged: Judged) {
  if (!judged.asked && !judged.failed.length) return 'No Claude Code version needs a verdict.'
  const counts = `Judged ${judged.recorded} of ${judged.asked} versions, ${judged.relevant} relevant.`
  return judged.failed.length ? `${counts} Failed: ${judged.failed.join('; ')}` : counts
}

// What the Live sessions panel shows as State and Doing now. One state object per
// session lives in memory and is written to <config dir>/cc-dashboard/activity/
// <session id>.json when it changes, at most every ACTIVITY_WRITE_MS. Only the main
// loop counts: events with an agentId come from a subagent.
const ACTIVITY_WRITE_MS = 250
const DETAIL_MAX = 60
// The same characters lib/activity.js accepts, because the id becomes a file name.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

type ToolRun = { name: string; detail: string; startedAt: number }
type Activity = {
  sessionId: string
  state: 'working' | 'waiting' | 'approval'
  since: number
  tool: ToolRun | null
  subagents: number
  updatedAt: number
}

const activities = new Map<string, Activity>()
// Main-loop tools that have started and not returned, by session id and tool_use_id,
// oldest first. Tools can run in parallel, and the newest one is the one shown.
const runningTools = new Map<string, Map<string, ToolRun>>()
const lastWriteAt = new Map<string, number>()
const writeScheduled = new Set<string>()

function toolsOf(id: string) {
  let tools = runningTools.get(id)
  if (!tools) {
    tools = new Map()
    runningTools.set(id, tools)
  }
  return tools
}

const newestTool = (tools: Map<string, ToolRun>) => [...tools.values()].pop() ?? null

// A new activity starts as working: the first event seen mid-turn, after a reload,
// is a tool call or a check, and the turn is running.
function setState(a: Activity, state: Activity['state'], now: number) {
  if (a.state === state) return
  a.state = state
  a.since = now
}

// The command cut to DETAIL_MAX characters for Bash, the file's name for Read, Edit
// and Write, and nothing for any other tool. Whitespace runs become one space, so a
// multi-line command stays on one line.
function toolDetail(tool: string, args: Record<string, unknown>) {
  if (tool === 'Bash') {
    return typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX) : ''
  }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    return typeof args.file_path === 'string' ? (args.file_path.split(/[\\/]/).pop() ?? '') : ''
  }
  return ''
}

async function subagentCount($: EngineInterface) {
  try {
    const live = ['pending', 'running', 'waiting']
    return (await $.agent.list()).filter((agent) => live.includes(agent.status)).length
  } catch {
    return 0
  }
}

async function writeActivity($: EngineInterface, a: Activity) {
  const dir = await configDir($)
  if (!dir) return
  const body = { ...a, subagents: await subagentCount($) }
  await $.fs.write(`${dir}/cc-dashboard/activity/${a.sessionId}.json`, JSON.stringify(body))
}

// Applies change to the session's state, then writes it. A write within
// ACTIVITY_WRITE_MS of the last one waits for a timer and writes the newest state
// once. A change that returns false means nothing changed, and nothing is written.
// Never throws, so a hook that calls it still returns next(e)'s result.
async function track($: EngineInterface, change: (a: Activity, now: number) => void | false) {
  try {
    const id = await $.session.id()
    if (!SESSION_ID.test(id)) return
    const now = await $.clock.now()
    const a = activities.get(id) ?? { sessionId: id, state: 'working' as const, since: now, tool: null, subagents: 0, updatedAt: now }
    activities.set(id, a)
    if (change(a, now) === false) return
    a.updatedAt = now
    const last = lastWriteAt.get(id)
    if (last === undefined || now - last >= ACTIVITY_WRITE_MS) {
      lastWriteAt.set(id, now)
      await writeActivity($, a)
    } else if (!writeScheduled.has(id)) {
      writeScheduled.add(id)
      $.clock.after(ACTIVITY_WRITE_MS - (now - last), () => {
        writeScheduled.delete(id)
        const latest = activities.get(id)
        if (!latest) return
        $.clock.now()
          .then((at) => {
            lastWriteAt.set(id, at)
            return writeActivity($, latest)
          })
          .catch((err) => fail($, `activity failed (${errorName(err)})`))
      })
    }
  } catch (err) {
    fail($, `activity failed (${errorName(err)})`)
  }
}

export const register: Register = (on) => {
  // Registers /backfill-updates, checks whether the running Claude Code version has a
  // verdict, and reviews sessions that have ended. Both run from timers, after session
  // start returns, because session.start is awaited before the first prompt. A -p or
  // Agent SDK run starts no reviews: it can exit mid-call and leave claimed sessions
  // pending for an hour.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'backfill-updates',
      description: 'Judge every Claude Code version in the transcripts for changes that could affect usage',
    }).catch((err) => note($, `could not register /backfill-updates (${errorName(err)})`))
    const result = await next(e)
    $.clock.after(0, () => {
      checkVersion($).catch((err) => note($, `update check failed (${errorName(err)})`))
    })
    if (e.isInteractive) startReviews($)
    return result
  })

  on('command.run', { command: 'backfill-updates' }, async ($) => ({ text: backfillText(await judgeUpdates($)) }))

  // Fires after each main-thread turn and when a rate-limit window moves a whole
  // point, so Plan usage stays current through a long turn.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const input = await statuslineInput($, e)
      if (input) await run($, 'record-statusline', input, MEASURE_TIMEOUT_MS)
    } catch (err) {
      fail($, `measure failed (${err instanceof Error ? err.name : 'error'})`)
    }
    return result
  })

  // Marks the session's snapshot as ended, so the Live sessions panel shows it as
  // cleared or ended at once instead of live for 10 minutes. A /clear arrives here
  // with reason 'clear'. The process goes on after a /clear and after an in-process
  // /resume (reason 'resume'), and no session.start follows either, so the review
  // of the ended session starts here. After any other end, the next session.start
  // reviews it.
  on('session.end', async ($, e, next) => {
    // The script starts before next, so it does not wait for the other hooks.
    // run never throws.
    const running = run($, 'record-session-end', { session_id: e.sessionId, reason: e.reason }, END_TIMEOUT_MS)
    const result = await next(e)
    await running
    if (e.reason === 'clear' || e.reason === 'resume') startReviews($)
    return result
  })

  // A turn that begins is working. turn.start has no agentId: a subagent's run raises
  // none.
  on('turn.start', async ($, e, next) => {
    await track($, (a, now) => setState(a, 'working', now))
    return next(e)
  })

  // A turn that ends leaves the session waiting on the user, whatever the reason.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await track($, (a, now) => {
        toolsOf(a.sessionId).clear()
        a.tool = null
        setState(a, 'waiting', now)
      })
    }
    return next(e)
  })

  // The tool is set before next(e) and cleared after it, even when the call throws.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    const id = e.tool_use_id
    const args = e as unknown as Record<string, unknown>
    await track($, (a, now) => {
      const run = { name: e.tool, detail: toolDetail(e.tool, args), startedAt: now }
      toolsOf(a.sessionId).set(id, run)
      a.tool = run
    })
    try {
      return await next(e)
    } finally {
      await track($, (a) => {
        const tools = toolsOf(a.sessionId)
        tools.delete(id)
        a.tool = newestTool(tools)
      })
    }
  })
}
