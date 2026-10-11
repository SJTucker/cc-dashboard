import type { EngineInterface, Register, SessionMeasureInput, SessionRateLimit, Timer } from 'claude-code'
import { commandPaths, fallbackLabel, cleanLabel, includedPaths, lineDiff, settingsChanges, snapshotName } from './setup'
import type { Kind, SetupEntry, Snapshot } from './setup'

// Records the dashboard's plan usage and session snapshots by running the scripts
// in bin/, and judges new Claude Code releases
// for the setup changes markers through bin/judge-updates, and reviews ended sessions
// for setup suggestions through bin/review-session. At each interactive session start it
// also compares the setup files with stored copies and writes a marker for each change
// (checkSetup).
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
// One id per claude process, sent with every measure as launch_id. A /clear starts a
// new session id but the process and this module stay, so every session the process
// records shares the id, and the Today table groups them. statuslineInput sets it on
// first use, because module load has no $ to read the clock from. A reload makes a
// new one, which splits the launch into two groups. Math.random, because whether
// this runtime has crypto.randomUUID is not known. The value fits SESSION_ID_PATTERN
// in lib/session-id.js, which recordSession checks.
let launchId: string | undefined

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
// cached path is not checked again. session.end drops the ended session's path:
// only session.measure reads this map, for the current session id.
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
    // The first prompt writes the transcript, and a session's first measure arrives
    // before it, carrying cost { usd: 0 }. Before a prompt there is no session to
    // record yet, and the next measure retries.
    if ((await $.session.turns()) > 0) fail($, 'transcript not found')
    return null
  }
  // Read the clock before the check so no await sits between the check and the
  // assignment; two overlapping first measures then cannot each assign an id.
  const now = await $.clock.now()
  launchId ??= `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const input: Record<string, unknown> = {
    session_id: id,
    launch_id: launchId,
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
// <config dir>/cc-dashboard/updates.json. Null when no path can be built.
async function updatesPath($: EngineInterface) {
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
// No state marks a permission prompt. tool.check answers ask before the permission
// mode settles the call, and the mod API exposes no way to read the session's mode.
// In auto mode the classifier settles an ask with no event, so ask alone does not
// mean a dialog opened.
const ACTIVITY_WRITE_MS = 250
const DETAIL_MAX = 60
// The same characters as SESSION_ID_PATTERN in lib/session-id.js, because the id becomes a file name. The mod cannot require lib/, so test/session-id.test.js checks the two match.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

type ToolRun = { name: string; detail: string; startedAt: number }
type Activity = {
  sessionId: string
  state: 'working' | 'waiting'
  since: number
  tool: ToolRun | null
  subagents: number
  updatedAt: number
}

const activities = new Map<string, Activity>()
// Main-loop tools that have started and not returned, by session id and tool_use_id,
// oldest first. Tools can run in parallel, and the newest one is the one shown.
const runningTools = new Map<string, Map<string, ToolRun>>()
// Subagents whose turn.complete has fired, by session id. The count leaves them out
// until $.agent.list() stops reporting them as pending, running or waiting, because
// the engine may not have updated the status yet when the turn.complete hook runs.
const endedAgents = new Map<string, Set<string>>()
const lastWriteAt = new Map<string, number>()
// The throttle timer of a session with a write waiting on it.
const writeTimers = new Map<string, Timer>()
// Each session's writes run one after another on one promise chain, so the last
// write to finish is the last one started. The text last written, by session id,
// lets a write with nothing new be skipped.
const writing = new Map<string, Promise<void>>()
const lastWritten = new Map<string, string>()

function toolsOf(id: string) {
  let tools = runningTools.get(id)
  if (!tools) {
    tools = new Map()
    runningTools.set(id, tools)
  }
  return tools
}

const newestTool = (tools: Map<string, ToolRun>) => [...tools.values()].pop() ?? null

// A new activity starts as working. Only a main-loop event creates one: turn.start,
// a main-loop tool.call, or turn.complete, which sets waiting at once. After a reload
// mid-turn, the first of these is a tool call, and the turn is running. Subagent
// events and agent.spawn create none, because the main loop may be waiting.
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

// An agent counts while it is pending, running or waiting: all three are work that
// has not ended. idle is a teammate between turns, and completed, failed and killed
// have ended. An agent in the session's endedAgents does not count. It leaves
// endedAgents once the list no longer reports it in progress, so an agent resumed
// later under the same id counts again.
async function subagentCount($: EngineInterface, id: string) {
  try {
    const live = ['pending', 'running', 'waiting']
    const inProgress = (await $.agent.list()).filter((agent) => live.includes(agent.status))
    const ended = endedAgents.get(id)
    for (const agentId of ended ?? []) {
      if (!inProgress.some((agent) => agent.id === agentId)) ended?.delete(agentId)
    }
    return inProgress.filter((agent) => !ended?.has(agent.id)).length
  } catch {
    return 0
  }
}

// Reads the session's state after its own awaits, so the text written is the state
// at the moment of writing, not the state when the write was queued.
async function writeActivity($: EngineInterface, id: string) {
  const dir = await configDir($)
  if (!dir) return
  const subagents = await subagentCount($, id)
  const a = activities.get(id)
  if (!a) return
  const text = JSON.stringify({ ...a, subagents })
  if (lastWritten.get(id) === text) return
  await $.fs.write(`${dir}/cc-dashboard/activity/${id}.json`, text)
  // A session.end during the write released the session, and this keeps it released.
  if (activities.get(id) === a) lastWritten.set(id, text)
}

// Adds a write to the end of the session's chain and returns at once. A failed
// write is logged, and the chain goes on with the next one.
function queueWrite($: EngineInterface, id: string) {
  const previous = writing.get(id) ?? Promise.resolve()
  writing.set(id, previous.then(() => writeActivity($, id)).catch((err) => fail($, `activity failed (${errorName(err)})`)))
}

// Applies change to the session's state, then queues a write of it. A change within
// ACTIVITY_WRITE_MS of the last write waits for a timer and writes the newest state
// once. A change that returns false means nothing changed, and nothing is written.
// Never throws and never waits for a write, so a hook that calls it reaches next(e)
// without disk I/O and still returns next(e)'s result. With create false, a session
// that has no state yet is left alone.
async function track($: EngineInterface, change: (a: Activity, now: number) => void | false, create = true) {
  try {
    const id = await $.session.id()
    if (!SESSION_ID.test(id)) return
    const now = await $.clock.now()
    const known = activities.get(id)
    if (!known && !create) return
    const a = known ?? { sessionId: id, state: 'working' as const, since: now, tool: null, subagents: 0, updatedAt: now }
    if (change(a, now) === false) return
    activities.set(id, a)
    a.updatedAt = now
    const last = lastWriteAt.get(id)
    if (last === undefined || now - last >= ACTIVITY_WRITE_MS) {
      lastWriteAt.set(id, now)
      queueWrite($, id)
    } else if (!writeTimers.has(id)) {
      const timer = $.clock.after(ACTIVITY_WRITE_MS - (now - last), () => {
        writeTimers.delete(id)
        $.clock.now()
          .then((at) => {
            // session.end can run while the time is asked for.
            if (!activities.has(id)) return
            lastWriteAt.set(id, at)
            queueWrite($, id)
          })
          .catch((err) => fail($, `activity failed (${errorName(err)})`))
      })
      writeTimers.set(id, timer)
    }
  } catch (err) {
    fail($, `activity failed (${errorName(err)})`)
  }
}

// Releases everything held for a session that ended. Its throttle timer is
// cancelled, so a write waiting on it never lands. A write already queued finds no
// state and writes nothing. A write already inside fs.write finishes, and
// writeActivity does not record its text.
function forgetSession(id: string) {
  activities.delete(id)
  runningTools.delete(id)
  endedAgents.delete(id)
  transcripts.delete(id)
  lastWriteAt.delete(id)
  writeTimers.get(id)?.cancel()
  writeTimers.delete(id)
  writing.delete(id)
  lastWritten.delete(id)
}

// Setup change markers. At each interactive session start, checkSetup compares the
// setup files with the copies stored at the last check and writes one entry per
// change to <config dir>/cc-dashboard/changes/<session id>.json, which
// lib/changes.js reads. An entry is dated to the file's mtime, so a change found
// sessions later still lands on the day it was made.

const SETUP_KEY = 'setup'
const LABEL_TIMEOUT_MS = 15_000
const LABEL_PROMPT_MAX = 4096
const LABEL_SYSTEM =
  'You name edits to a Claude Code setup file for a dashboard of setup changes. Reply with one line of at most 60 characters ' +
  "that says what the edit changes, in lower case, without the file name and without quotes. Examples: don't commit docs; " +
  'use cx for complexity; run playwright-cli before claiming a UI works.'

// prose files get a Haiku label, settings files a key diff, scripts their name, rtk
// files their first added line.
type Mode = 'prose' | 'settings' | 'script' | 'rtk'
// `folder` decides whether a file with no snapshot is new (its folder was checked
// before) or seen for the first time (no marker).
type Watched = { path: string; kind: Kind; name: string; folder: string; mode: Mode }
// `checked` holds, per folder, the time of the last check that covered it.
type SetupState = { folders: string[]; mtimes: Record<string, number | null>; checked: Record<string, number> }
type Change = { w: Watched; t: number; before: string | null; after: string | null }
type Checked = { path: string; mtime: number | null; snapshot?: Snapshot; change?: Change }

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// A file in skills/, agents/ or rules/, from its path. Used for the folder listings
// and for paths the index holds that a listing no longer returns, so a deleted
// skill folder is still checked and found removed.
function folderFile(dir: string, path: string): Watched | null {
  const skill = new RegExp(`^${escapeRegExp(dir)}/skills/([^/]+)/SKILL\\.md$`).exec(path)
  if (skill?.[1]) return { path, kind: 'skill', name: `skill ${skill[1]}`, folder: `${dir}/skills`, mode: 'prose' }
  const agent = new RegExp(`^${escapeRegExp(dir)}/agents/([^/]+)\\.md$`).exec(path)
  if (agent?.[1]) return { path, kind: 'skill', name: `agent ${agent[1]}`, folder: `${dir}/agents`, mode: 'prose' }
  if (path.startsWith(`${dir}/rules/`) && path.endsWith('.md')) {
    return { path, kind: 'claude-md', name: `rules/${path.slice(dir.length + 7)}`, folder: `${dir}/rules`, mode: 'prose' }
  }
  return null
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function ruleFiles($: EngineInterface, folder: string, depth: number): Promise<string[]> {
  const out: string[] = []
  for (const e of await $.fs.list(folder).catch(() => [])) {
    const path = `${folder}/${e.name}`
    if (e.kind === 'dir' && depth > 0) out.push(...(await ruleFiles($, path, depth - 1)))
    else if (e.kind === 'file' && e.name.endsWith('.md')) out.push(path)
  }
  return out
}

// Every file the check covers, without duplicates.
async function watchedFiles($: EngineInterface, dir: string, home: string, root: string | null, state: SetupState) {
  const files: Watched[] = [
    { path: `${dir}/CLAUDE.md`, kind: 'claude-md', name: 'CLAUDE.md', folder: dir, mode: 'prose' },
    { path: `${dir}/settings.json`, kind: 'config', name: 'settings.json', folder: dir, mode: 'settings' },
    { path: `${dir}/settings.local.json`, kind: 'config', name: 'settings.local.json', folder: dir, mode: 'settings' },
  ]
  const rtk = `${home}/Library/Application Support/rtk`
  for (const name of ['config.toml', 'filters.toml']) {
    files.push({ path: `${rtk}/${name}`, kind: 'rtk', name: `rtk ${name}`, folder: dir, mode: 'rtk' })
  }
  const claudeText = await $.fs.read(`${dir}/CLAUDE.md`).then(String, () => '')
  for (const path of includedPaths(claudeText, dir, home)) {
    files.push({ path, kind: 'claude-md', name: baseName(path), folder: dir, mode: 'prose' })
  }
  const settingsText = await $.fs.read(`${dir}/settings.json`).then(String, () => '')
  const scripts = commandPaths(settingsText, home)
  for (const path of scripts.hooks) files.push({ path, kind: 'hook', name: 'hook script', folder: dir, mode: 'script' })
  if (scripts.statusline) {
    files.push({ path: scripts.statusline, kind: 'config', name: 'statusline', folder: dir, mode: 'script' })
  }
  const listed: string[] = [...(await ruleFiles($, `${dir}/rules`, 3))]
  for (const e of await $.fs.list(`${dir}/skills`).catch(() => [])) listed.push(`${dir}/skills/${e.name}/SKILL.md`)
  for (const e of await $.fs.list(`${dir}/agents`).catch(() => [])) {
    if (e.name.endsWith('.md')) listed.push(`${dir}/agents/${e.name}`)
  }
  const known = Object.entries(state.mtimes).filter(([, mtime]) => mtime !== null).map(([path]) => path)
  for (const path of [...listed, ...known]) {
    const w = folderFile(dir, path)
    if (w) files.push(w)
  }
  if (root) {
    const project = baseName(root)
    files.push(
      { path: `${root}/CLAUDE.md`, kind: 'claude-md', name: `${project}/CLAUDE.md`, folder: root, mode: 'prose' },
      { path: `${root}/CLAUDE.local.md`, kind: 'claude-md', name: `${project}/CLAUDE.local.md`, folder: root, mode: 'prose' },
      { path: `${root}/.claude/settings.json`, kind: 'config', name: `${project}/settings.json`, folder: root, mode: 'settings' },
    )
  }
  const seen = new Set<string>()
  return files.filter((w) => !seen.has(w.path) && seen.add(w.path))
}

async function fileMtime($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path).catch(() => null)
  return stat?.kind === 'file' ? stat.mtimeMs : null
}

async function readSnapshot($: EngineInterface, dir: string, path: string): Promise<Snapshot | null> {
  const text = await $.fs.read(`${dir}/cc-dashboard/setup/${snapshotName(path)}`).then(String, () => undefined)
  if (text === undefined) return null
  try {
    const s = JSON.parse(text) as Partial<Snapshot>
    const isValid = s.path === path && typeof s.mtimeMs === 'number' && (typeof s.text === 'string' || s.text === null)
    return isValid ? (s as Snapshot) : null
  } catch {
    return null
  }
}

// One file: null when its mtime matches the index, so nothing is read. Otherwise
// the snapshot to store and, when the text differs from the last check, the change.
async function checkFile($: EngineInterface, dir: string, w: Watched, state: SetupState, now: number): Promise<Checked | null> {
  const mtime = await fileMtime($, w.path)
  const known = Object.hasOwn(state.mtimes, w.path) ? state.mtimes[w.path] : undefined
  if (known === mtime) return null
  const snapshot = await readSnapshot($, dir, w.path)
  const before = snapshot?.text ?? null
  if (mtime === null) {
    // Gone. Only a file that had text at the last check is reported, once.
    if (before === null) return { path: w.path, mtime }
    return { path: w.path, mtime, snapshot: { path: w.path, mtimeMs: 0, text: null }, change: { w, t: now, before, after: null } }
  }
  const after = await $.fs.read(w.path).then(String, () => null)
  if (after === null) return null // unreadable now: left for the next session
  const stored = { path: w.path, mtimeMs: mtime, text: after }
  // An added file can keep an old mtime (a symlink, an unzip, mv, cp -p): date it no
  // earlier than the last check of its folder.
  const when = Math.max(mtime, state.checked[w.folder] ?? 0)
  if (before === null) {
    // No text stored: new if it was missing before, or never indexed in a folder that
    // was checked before. A file indexed with a lost snapshot is a baseline.
    const isNew = known === null || snapshot?.text === null || (known === undefined && state.folders.includes(w.folder))
    return { path: w.path, mtime, snapshot: stored, ...(isNew && { change: { w, t: when, before: null, after } }) }
  }
  return { path: w.path, mtime, snapshot: stored, ...(before !== after && { change: { w, t: mtime, before, after } }) }
}

async function haikuLabel($: EngineInterface, name: string, added: string[], removed: string[]) {
  const prompt = `File: ${name}\n\nAdded lines:\n${added.join('\n')}\n\nRemoved lines:\n${removed.join('\n')}`.slice(0, LABEL_PROMPT_MAX)
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: LABEL_SYSTEM,
      prompt,
      maxTokens: 2048,
      effort: 'medium',
      timeoutMs: LABEL_TIMEOUT_MS,
    })
    return reply.isAnswered ? cleanLabel(reply.text) : null
  } catch {
    return null
  }
}

async function entriesFor($: EngineInterface, c: Change): Promise<SetupEntry[]> {
  const base = { t: c.t, name: c.w.name, file: c.w.path }
  const who = c.w.mode === 'script' ? `${baseName(c.w.path)} ` : ''
  if (c.before === null) return [{ ...base, kind: c.w.kind, label: `${who}added` }]
  if (c.after === null) return [{ ...base, kind: c.w.kind, label: `${who}removed` }]
  if (c.w.mode === 'settings') {
    const changes = settingsChanges(c.before, c.after)
    if (changes === null) return [{ ...base, kind: 'config', label: 'changed' }]
    return changes.map(({ kind, label }) => ({ ...base, kind, label }))
  }
  if (c.w.mode === 'script') return [{ ...base, kind: c.w.kind, label: `${baseName(c.w.path)} changed` }]
  const { added, removed } = lineDiff(c.before, c.after)
  if (c.w.mode === 'rtk') return [{ ...base, kind: c.w.kind, label: fallbackLabel(added, []) }]
  if (!added.length && !removed.length) return [{ ...base, kind: c.w.kind, label: 'changed' }]
  const label = (await haikuLabel($, c.w.name, added, removed)) ?? fallbackLabel(added, removed)
  return [{ ...base, kind: c.w.kind, label }]
}

function readSetupState(saved: unknown): SetupState {
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<SetupState>
  const folders = Array.isArray(s.folders) ? s.folders.filter((f): f is string => typeof f === 'string') : []
  // A copy: checkSetup changes it, and the stored value must change only through store.set.
  const mtimes = typeof s.mtimes === 'object' && s.mtimes !== null ? { ...s.mtimes } : {}
  const checked: Record<string, number> = {}
  if (typeof s.checked === 'object' && s.checked !== null) {
    for (const [k, v] of Object.entries(s.checked)) if (typeof v === 'number') checked[k] = v
  }
  return { folders, mtimes, checked }
}

// The marker file is written first, then the snapshots, then the index. A failed
// marker write throws before the rest, so the next session finds the change again.
async function checkSetup($: EngineInterface) {
  const dir = await configDir($)
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  if (!dir || !home || !SESSION_ID.test(id)) return
  const root = await $.session.root().catch(() => null)
  const now = await $.clock.now()
  const state = readSetupState(await $.store.get(SETUP_KEY))
  const files = await watchedFiles($, dir, home, root, state)
  const checked: Checked[] = []
  for (const w of files) {
    const c = await checkFile($, dir, w, state, now)
    if (c) checked.push(c)
  }
  const entries: SetupEntry[] = []
  for (const c of checked) if (c.change) entries.push(...(await entriesFor($, c.change)))
  if (entries.length) {
    const file = `${dir}/cc-dashboard/changes/${id}.json`
    // A resumed session starts again with the same id: keep what it wrote before.
    const earlier = await $.fs.read(file).then((text) => JSON.parse(String(text)) as unknown, () => [])
    const kept = Array.isArray(earlier) ? earlier : []
    await $.fs.write(file, `${JSON.stringify([...kept, ...entries], null, 2)}\n`)
  }
  for (const c of checked) {
    if (c.snapshot) await $.fs.write(`${dir}/cc-dashboard/setup/${snapshotName(c.path)}`, JSON.stringify(c.snapshot))
    state.mtimes[c.path] = c.mtime
  }
  // The three listed folders count as checked even when empty, so their first file is marked added.
  const listedFolders = ['skills', 'agents', 'rules'].map((name) => `${dir}/${name}`)
  const thisRun = [...new Set([...files.map((w) => w.folder), ...listedFolders])]
  state.folders = [...new Set([...state.folders, ...thisRun])]
  for (const folder of thisRun) state.checked[folder] = now
  await $.store.set(SETUP_KEY, state)
}

export const register: Register = (on) => {
  // Registers /backfill-updates inline. The version check runs in every session. The
  // reviews and the setup check run in interactive sessions only. All three run from
  // timers after session.start returns, because session.start is awaited before the
  // first prompt. A -p or Agent SDK run starts no reviews: it can exit mid-call and
  // leave claimed sessions pending for an hour.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'backfill-updates',
      description: 'Judge every Claude Code version in the transcripts for changes that could affect usage',
    }).catch((err) => note($, `could not register /backfill-updates (${errorName(err)})`))
    const result = await next(e)
    $.clock.after(0, () => {
      checkVersion($).catch((err) => note($, `update check failed (${errorName(err)})`))
    })
    if (e.isInteractive) {
      startReviews($)
      $.clock.after(0, () => {
        checkSetup($).catch((err) => note($, `setup check failed (${errorName(err)})`))
      })
    }
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
    forgetSession(e.sessionId)
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
  // A subagent's turn that ends changes the subagent count. Its agentId goes into
  // endedAgents, so the count leaves it out even while $.agent.list() still reports
  // it running, and the file is rewritten.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const agentId = e.agentId
      const result = await next(e)
      await track($, (a) => {
        let ended = endedAgents.get(a.sessionId)
        if (!ended) {
          ended = new Set()
          endedAgents.set(a.sessionId, ended)
        }
        ended.add(agentId)
      }, false)
      return result
    }
    await track($, (a, now) => {
      toolsOf(a.sessionId).clear()
      a.tool = null
      setState(a, 'waiting', now)
    })
    return next(e)
  })

  // The tool is set before next(e) and cleared after it, even when the call throws.
  on('tool.call', async ($, e, next) => {
    // A subagent's call that returns or throws rewrites the file, so subagents and
    // updatedAt stay current while the main loop waits.
    if (e.agentId) {
      try {
        return await next(e)
      } finally {
        await track($, () => {}, false)
      }
    }
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

  // While subagents work, the main loop raises no event, so a spawn rewrites the
  // file with the new subagent count.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await track($, () => {}, false)
    return result
  })
}
