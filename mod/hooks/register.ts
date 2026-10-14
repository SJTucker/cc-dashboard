import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, SessionRateLimit, Timer } from 'claude-code'
import { commandPaths, fallbackLabel, cleanLabel, includedPaths, lineDiff, settingsChanges, snapshotName } from './setup'
import type { Kind, SetupEntry, Snapshot } from './setup'
import { projectFolder, rateLimitsInput, statuslineRecord } from './statusline'
import type { Frozen } from './statusline'
import { newestTool, setState, toolDetail, toolsOf } from './activity'
import type { Activity, ToolRun } from './activity'
import { parseSteps, stepOf, stepsText } from './steps'
import type { AgentStep } from './steps'
import { REPO_STEPS, handoffDocument, planHandoff, resumePrompt } from './handoff'
import type { StepOutput } from './handoff'
import { NO_LEVELS, bandText, dismissLevels, liveReadings, maxLevels, parseLevels, readingsOf, resetLevels, sameLevels, shownWindows } from './limits'

// Records the dashboard's plan usage and session snapshots by running the scripts
// in bin/, and judges new Claude Code releases for the setup changes markers
// through bin/judge-updates, and reviews ended sessions
// for setup suggestions through bin/review-session. At each interactive session start it
// also compares the setup files with stored copies and writes a marker for each change
// (checkSetup). It also shows a dismissable plan limit band above the prompt when the
// Session or Week window passes 75% or 90%, and shares the dismissal between running
// sessions through limit-warnings.json.
// The bin/ scripts write the session, usage, update-verdict and review files, so the
// formats, the atomic writes and the freshness checks of those files are theirs.
// The mod writes five formats itself with $.fs.write, under <config dir>/cc-dashboard/:
//   activity/<session id>.json   the session's state. Read by lib/activity.js.
//   agent-usage/<agent id>.json  each model request of a subagent (steps.ts). Read by lib/agent-steps.js.
//   changes/<session id>.json    the setup changes checkSetup found. Read by collectMarkers in lib/changes.js.
//   setup/<name>.json            the stored copy of each watched setup file. Read back by checkSetup.
//   limit-warnings.json          the dismissed plan limit levels. Read by every running session's mod.
// Activity has one writer per session, which keeps a session's states in order, where a
// script started per event can finish out of order. The server reads the first three
// formats, and the CONTRACT block in register.test.ts holds a sample of each, which
// test/mod-contract.test.js parses with the server's readers.
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

// `claude plugin validate` refuses a function that takes $ unless it is declared at
// the top of the file, so these flags are module variables. A reload starts them
// over, which costs one more fs.stat or one more log line.
let binDir: string | undefined
// Messages already logged. Each distinct failure logs once, so a second kind of failure
// still shows after the first.
const logged = new Set<string>()
// One id per claude process, sent with every measure as launch_id. A /clear starts a
// new session id but the process and this module stay, so every session the process
// records shares the id, and the Today table groups them. statuslineInput sets it on
// first use, because module load has no $ to read the clock from. A reload makes a
// new one, which splits the launch into two groups. Math.random, because whether
// this runtime has crypto.randomUUID is not known. The value fits SESSION_ID_PATTERN
// in lib/session-id.js, which recordSession checks.
let launchId: string | undefined
// The session id the last /clear in this process ended. statuslineInput sends it as
// cleared_from with every measure of a later session, and lib/sessions.js stores it, so
// the Session timeline draws the new session's lane under the old one. session.end sets
// it on a /clear and drops it on any other end, so the session an in-process /resume
// opens carries no link. A reload drops it too. A /clear of a session with no transcript
// keeps the earlier link, because that session never gets a row for the next one to link to.
let clearedFrom: string | undefined
// Whether this module has cleared the status yet. The engine keeps a plugin's status
// until the plugin replaces or clears it, and a reload empties handoffs. So a status
// shown before a reload would otherwise stay for the rest of the process. The first
// turn.start after a load clears it once, and deletes the session's stored handoff.
let statusCleared = false

function fail($: EngineInterface, text: string) {
  if (logged.has(text)) return
  logged.add(text)
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
  const folder = projectFolder(root)
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
  const modelId = await $.session.model()
  const cost = e.cost ? { usd: e.cost.usd, startedAt: (await $.session.usage()).startedAt, now: await $.clock.now() } : undefined
  return statuslineRecord({ id, launchId, transcript, root, modelId, clearedFrom, cost, rateLimits })
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
  const label = [name, ...args.slice(0, 1)].join(' ')
  const { exitCode, stdout, stderr } = await $.process.run([await scriptPath($, name), ...args], { stdin, timeoutMs })
  if (exitCode !== 0) throw new Error(`${label} failed (exit ${exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`)
  // A JSON.parse error message can quote the start of its input, which here may be
  // transcript text, so the message is replaced.
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${label} printed invalid JSON`)
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
// The same characters as SESSION_ID_PATTERN in lib/session-id.js, because the id becomes a file name. The mod cannot require lib/, so test/session-id.test.js checks the two match.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

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

// Each subagent's recorded steps, and the chain that orders the writes of its file.
// See steps.ts. A reload starts these empty; recordStep reads the file back.
const agentSteps = new Map<string, AgentStep[]>()
const stepWrites = new Map<string, Promise<void>>()
const lastWritten = new Map<string, string>()

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

// Adds one step to the agent's list and writes the whole list. The first step of an
// agent this module instance has not seen reads the agent's file first, so a reload
// keeps the steps written before it. An agent id that is not a plain name is not
// used as a file name.
async function recordStep($: EngineInterface, agentId: string, step: AgentStep) {
  if (!/^[\w-]+$/.test(agentId)) return
  const dir = await configDir($)
  if (!dir) return
  const file = `${dir}/cc-dashboard/agent-usage/${agentId}.json`
  let steps = agentSteps.get(agentId)
  if (!steps) {
    steps = parseSteps(await $.fs.read(file).then(String, () => undefined))
    agentSteps.set(agentId, steps)
  }
  steps.push(step)
  await $.fs.write(file, stepsText(agentId, steps))
}

// Adds a step write to the end of the agent's chain and returns at once. A failed
// write is logged, and the chain goes on with the next one.
function queueStep($: EngineInterface, agentId: string, step: AgentStep) {
  const previous = stepWrites.get(agentId) ?? Promise.resolve()
  stepWrites.set(agentId, previous.then(() => recordStep($, agentId, step)).catch((err) => fail($, `agent usage failed (${errorName(err)})`)))
}

// Drops the agent's steps and its write chain once its last queued write settles.
// A step queued after this call finds no entry and starts a new list from the file.
function forgetAgentSteps(agentId: string) {
  const chain = stepWrites.get(agentId)
  if (!chain) return
  chain.finally(() => {
    if (stepWrites.get(agentId) !== chain) return
    stepWrites.delete(agentId)
    agentSteps.delete(agentId)
  })
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
// cancelled, so a timer that has not fired never queues a write. A timer callback
// already waiting on clock.now checks activities.has(id) and returns, so it queues
// no write either. A write already queued finds no state in writeActivity and writes
// nothing. A write already inside fs.write finishes, and writeActivity does not
// record its text.
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
  handoffs.delete(id)
  cancelHandoffTimer(id)
}

// Handoffs before the prompt cache expires. The mod writes a handoff document from a
// fork of the full conversation, so the user can /clear and resume from the file
// instead of a summary or a cold cache. Two triggers start one. Claude Code's idle
// compaction raises session.compact, in a 1h session with at least 200k tokens of
// context. The mod's own timer (handoffTimers) covers 1h sessions from 50k tokens
// up, and users who turned idle compaction off.
// A session's entry is 'writing' while the fork runs, 'ready' once the file is
// written, and 'failed' when the write gave up. Any entry blocks a second handoff
// until turn.start removes it, so each idle gap gets one at most.
// A reload empties the map, so a ready entry is also kept in $.store under
// HANDOFF_KEY + session id, as { resume, at }. session.end reads it when the map has
// no ready entry. turn.start and session.end delete it. A process that dies without a
// session.end leaves its key behind, so each new ready entry deletes keys older than
// HANDOFF_STORE_MAX_AGE_MS.
const HANDOFF_KEY = 'handoff:'
const HANDOFF_STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const HANDOFF_STATUS = 'handoff ready · /clear to resume'
// $.ui.status() with no text clears the status. On Claude Code 2.1.296, $.ui.status('')
// pins an empty "⚠ cc-dashboard:" line above the input instead.
const HANDOFF_STEP_TIMEOUT_MS = 5000
type Handoff = { state: 'writing' | 'failed' } | { state: 'ready'; resume: string }
const handoffs = new Map<string, Handoff>()

// Runs each REPO_STEPS command in cwd. A command that fails or throws is recorded,
// not raised, because the prompt shows the failure the way the skill shows its errors.
async function repoState($: EngineInterface, cwd: string): Promise<StepOutput[]> {
  const outputs: StepOutput[] = []
  for (const step of REPO_STEPS) {
    try {
      const { exitCode, stdout, stderr } = await $.process.run([...step.argv], { cwd, timeoutMs: HANDOFF_STEP_TIMEOUT_MS })
      outputs.push({ label: step.label, ok: exitCode === 0, text: (exitCode === 0 ? stdout : stderr).trim() })
    } catch (err) {
      outputs.push({ label: step.label, ok: false, text: errorName(err) })
    }
  }
  return outputs
}

// The fork reads the conversation from before the compaction, from the cache, and
// adds no transcript line. The file is written even when a turn or a /clear has come
// since, because it is still a record of the session. Only the status and the
// prefill need the entry to still be the one this call started, so a fork from an
// earlier idle gap cannot change a later gap's entry. fs.write creates the handoffs folder
// when it is missing.
async function writeHandoff($: EngineInterface, id: string, entry: Handoff) {
  const cwd = await $.session.cwd()
  const plan = planHandoff(await repoState($, cwd), cwd)
  if (!plan) throw new Error('no timestamp')
  const reply = await $.model.fork({ prompt: plan.prompt })
  if (!reply.isAnswered) throw new Error(`fork ${reply.reason}`)
  const doc = handoffDocument(reply.text)
  if (!doc) throw new Error('fork empty')
  await $.fs.write(plan.path, doc)
  if (handoffs.get(id) !== entry) return
  const resume = resumePrompt(plan.path)
  const ready: Handoff = { state: 'ready', resume }
  handoffs.set(id, ready)
  $.ui.status(HANDOFF_STATUS)
  const now = await $.clock.now()
  await $.store.set(HANDOFF_KEY + id, { resume, at: now })
  // A prompt or an end during the write removed the entry and found no key to delete.
  if (handoffs.get(id) !== ready) await $.store.delete(HANDOFF_KEY + id)
  await pruneHandoffs($, id, now)
}

// Deletes the stored handoffs of other sessions that are older than the maximum age.
// A key whose value has no numeric at is left alone.
async function pruneHandoffs($: EngineInterface, keep: string, now: number) {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(HANDOFF_KEY) || key === HANDOFF_KEY + keep) continue
    const stored = (await $.store.get(key)) as { at?: unknown } | undefined
    if (typeof stored?.at === 'number' && now - stored.at > HANDOFF_STORE_MAX_AGE_MS) await $.store.delete(key)
  }
}

// The resume prompt that a reload dropped from the map, or undefined when the store
// has none for the session. A store failure is logged and counts as none.
async function storedResume($: EngineInterface, id: string): Promise<string | undefined> {
  try {
    const stored = (await $.store.get(HANDOFF_KEY + id)) as { resume?: unknown } | undefined
    return typeof stored?.resume === 'string' ? stored.resume : undefined
  } catch (err) {
    note($, `handoff store read failed (${errorText(err)})`)
    return undefined
  }
}

async function deleteStoredHandoff($: EngineInterface, id: string) {
  try {
    await $.store.delete(HANDOFF_KEY + id)
  } catch (err) {
    note($, `handoff store delete failed (${errorText(err)})`)
  }
}

// Starts the handoff and returns at once. A failure is logged each time, because it
// happens at most once per idle gap.
function startHandoff($: EngineInterface, id: string) {
  const entry: Handoff = { state: 'writing' }
  handoffs.set(id, entry)
  writeHandoff($, id, entry).catch((err) => {
    if (handoffs.get(id) === entry) handoffs.set(id, { state: 'failed' })
    note($, `handoff failed (${errorText(err)})`)
  })
}

// The handoff timer. Claude Code gives the mod no cache TTL, so bin/cache-state reads
// it from the transcript, with the rule the dashboard uses. After each main-thread
// turn, armHandoff waits HANDOFF_ARM_DELAY_MS, so the turn.complete hook returns first
// and the transcript holds the turn's last call. The fire timer then runs
// HANDOFF_LEAD_MS before a 1h cache expires, the point Claude Code's idle compaction
// uses. A session's entry in handoffTimers is the arming timer, then the fire timer.
// turn.start and forgetSession cancel it. A reload cancels every timer and empties the
// map, so an idle gap that spans a reload gets no timer handoff. The timer arms only
// in sessions with a terminal, as idle compaction does. If the machine sleeps through
// the fire time, fireHandoff skips the fork once the cache's expiry has passed.
const HANDOFF_MIN_TOKENS = 50_000
const HANDOFF_LEAD_MS = 6 * 60 * 1000
const HANDOFF_ARM_DELAY_MS = 1000
const CACHE_STATE_TIMEOUT_MS = 5000
const handoffTimers = new Map<string, Timer>()

function cancelHandoffTimer(id: string) {
  handoffTimers.get(id)?.cancel()
  handoffTimers.delete(id)
}

// Arms the session's timer, replacing one an earlier turn armed. When the wait comes
// back, the arming timer must still be the session's entry, because a turn.start or a
// later turn.complete in the meantime makes this wait out of date.
function armHandoff($: EngineInterface, id: string) {
  cancelHandoffTimer(id)
  const arming = $.clock.after(HANDOFF_ARM_DELAY_MS, () => {
    handoffWait($, id)
      .then((armed) => {
        if (handoffTimers.get(id) !== arming) return
        handoffTimers.delete(id)
        if (armed === null) return
        const { wait, expiresAt } = armed
        const fire = $.clock.after(wait, () => {
          fireHandoff($, id, expiresAt).catch((err) => fail($, `handoff timer failed (${errorText(err)})`))
        })
        handoffTimers.set(id, fire)
      })
      .catch((err) => {
        if (handoffTimers.get(id) === arming) handoffTimers.delete(id)
        fail($, `handoff timer failed (${errorText(err)})`)
      })
  })
  handoffTimers.set(id, arming)
}

// Milliseconds until the handoff should start, with the cache expiry it was computed
// for, or null when this idle gap gets no timer: no terminal, under HANDOFF_MIN_TOKENS,
// no transcript, not a 1h cache, or too close to the expiry. A failing script throws.
async function handoffWait($: EngineInterface, id: string): Promise<{ wait: number; expiresAt: number } | null> {
  if ((await $.session.surfaces()).length === 0) return null
  const tokens = (await $.session.usage()).context.tokens
  if (typeof tokens !== 'number' || tokens < HANDOFF_MIN_TOKENS) return null
  const transcript = await transcriptPath($, await $.session.root(), id)
  if (!transcript) return null
  const cache = (await callScript($, 'cache-state', [], JSON.stringify({ transcript }), CACHE_STATE_TIMEOUT_MS)) as {
    ttl?: unknown
    expiresAt?: unknown
  }
  if (cache.ttl !== '1h' || typeof cache.expiresAt !== 'number') return null
  const wait = cache.expiresAt - HANDOFF_LEAD_MS - (await $.clock.now())
  return wait > 0 ? { wait, expiresAt: cache.expiresAt } : null
}

// The same checks as the session.compact trigger: the session is between turns and
// has no handoff in this idle gap. A fork after the cache expired would start cold, so
// it is skipped when the clock has reached expiresAt, as after the machine slept.
async function fireHandoff($: EngineInterface, id: string, expiresAt: number) {
  handoffTimers.delete(id)
  if ((await $.clock.now()) >= expiresAt) return
  if (activities.get(id)?.state === 'waiting' && !handoffs.has(id)) startHandoff($, id)
}

// A prompt makes the handoff out of date, so turn.start drops it and clears the
// status. The file stays on disk. The stored entry is deleted when the map had an
// entry, and on the first call after a load, because an earlier load of this module
// may have stored one that the map no longer holds. That first call also clears a
// status that an earlier load set. It also cancels the session's handoff timer.
async function dropHandoff($: EngineInterface) {
  try {
    const id = await $.session.id()
    cancelHandoffTimer(id)
    const handoff = handoffs.get(id)
    handoffs.delete(id)
    if (handoff?.state === 'ready' || !statusCleared) $.ui.status()
    if (handoff || !statusCleared) await deleteStoredHandoff($, id)
    statusCleared = true
  } catch (err) {
    fail($, `handoff failed (${errorName(err)})`)
  }
}

// A /clear raises session.end and no session.start, so the new session is only
// reachable from a timer set here. On Claude Code 2.1.296, a 4 s timer saw the new
// session id and filled its input box. The status clears either way. The fill is
// skipped when the user has typed in the box, and when they already sent a prompt,
// because a fill during a turn would be sent as the next prompt.
const PREFILL_DELAY_MS = 4000

function prefillAfterClear($: EngineInterface, resume: string) {
  $.clock.after(PREFILL_DELAY_MS, () => {
    fillResume($, resume).catch((err) => note($, `handoff prefill failed (${errorText(err)})`))
  })
}

// Clears the status, then puts the resume prompt in the input box of the new session.
// It does nothing when that session has a turn running or the box has text, because
// a fill then would be sent as a prompt or would overwrite the user's draft.
async function fillResume($: EngineInterface, resume: string) {
  $.ui.status()
  const id = await $.session.id()
  if (activities.get(id)?.state === 'working') return
  const draft = await $.prompt.read()
  if (draft.text.trim()) return
  await $.prompt.fill({ text: resume })
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

// The plan limit band above the prompt. session.measure stores the latest Session and
// Week readings and the dismissed levels in $.state. The band lists each window above
// its dismissed level. Dismiss writes the levels to limit-warnings.json, which every
// running session reads on its next measure and on the recheck timer.

const RECHECK_MS = 60_000
const band = atom({ plugin: 'cc-dashboard', key: 'limitBand' } as const, { readings: [], levels: NO_LEVELS, unsaved: false })

// A module variable, so a reload drops it. The next measure starts the timer again.
let recheck: Timer | undefined

async function limitsPath($: EngineInterface) {
  const dir = await configDir($)
  return dir ? `${dir}/cc-dashboard/limit-warnings.json` : null
}

async function readLevels($: EngineInterface, path: string) {
  return parseLevels(await $.fs.read(path).then(String, () => undefined))
}

// Stores this reading and resets a window that has dropped below the first level. The
// file is the source of truth. This session's levels count only while a Dismiss write
// is unsaved, and the write below retries it. A measure with no Session or Week window
// (an API-key login) leaves the band as it is.
async function measureBand($: EngineInterface, limits: readonly SessionRateLimit[]) {
  const readings = liveReadings(readingsOf(limits), await $.clock.now())
  if (!readings.length) return
  const path = await limitsPath($)
  const stored = path ? await readLevels($, path) : NO_LEVELS
  const held = await read($, band)
  const levels = resetLevels(readings, held.unsaved ? maxLevels(stored, held.levels) : stored)
  await update($, band, () => ({ readings, levels, unsaved: held.unsaved }))
  if (path) {
    if (!sameLevels(levels, stored)) await $.fs.write(path, JSON.stringify(levels))
    await update($, band, (b) => ({ ...b, unsaved: false }))
  }
  if (shownWindows(readings, levels).length) startRecheck($)
}

function startRecheck($: EngineInterface) {
  if (recheck) return
  recheck = $.clock.every(RECHECK_MS, () => {
    recheckBand($).catch((err) => fail($, `limit band recheck failed (${errorName(err)})`))
  })
}

// Picks up a dismissal another session wrote and redraws the reset countdown. A window
// whose reset time has passed leaves the band. Stops once the band shows nothing.
async function recheckBand($: EngineInterface) {
  const path = await limitsPath($)
  const file = path ? await readLevels($, path) : undefined
  const now = await $.clock.now()
  await update($, band, (b) => ({
    readings: liveReadings(b.readings, now),
    levels: file ? (b.unsaved ? maxLevels(file, b.levels) : file) : b.levels,
    unsaved: b.unsaved,
  }))
  const current = await read($, band)
  if (shownWindows(current.readings, current.levels).length) {
    $.ui.invalidate('ui.render')
    return
  }
  recheck?.cancel()
  recheck = undefined
}

// Hides the band in this session first, so a failed write still hides it here. The
// levels stay marked unsaved until the write succeeds.
async function dismissBand($: EngineInterface) {
  const current = await read($, band)
  const path = await limitsPath($)
  const stored = path ? await readLevels($, path) : NO_LEVELS
  const base = current.unsaved ? maxLevels(stored, current.levels) : stored
  const levels = dismissLevels(shownWindows(current.readings, current.levels), base)
  await update($, band, (b) => ({ ...b, levels, unsaved: true }))
  if (!path) return
  await $.fs.write(path, JSON.stringify(levels))
  await update($, band, (b) => ({ ...b, unsaved: false }))
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
    try {
      await measureBand($, e.rateLimits)
    } catch (err) {
      fail($, `limit band failed (${errorName(err)})`)
    }
    return result
  })

  // Marks the session's snapshot as ended, so the Live sessions panel shows it as
  // cleared or ended at once instead of live for 10 minutes. A /clear arrives here
  // with reason 'clear'. That reason also sets clearedFrom, which links the next
  // session to this one. The process goes on after a /clear and after an in-process
  // /resume (reason 'resume'), and no session.start follows either, so the review
  // of the ended session starts here. After any other end, the next session.start
  // reviews it. A ready handoff turns into a prefill of the next session's input on a
  // /clear, and its status is cleared on any other end. The handoff is the map's ready
  // entry, or else the stored one, which survives a reload. The stored entry is deleted
  // either way. A store failure is logged and does not stop the rest of the hook.
  on('session.end', async ($, e, next) => {
    const handoff = handoffs.get(e.sessionId)
    forgetSession(e.sessionId)
    // The script starts before next, so it does not wait for the other hooks.
    // run never throws.
    const running = run($, 'record-session-end', { session_id: e.sessionId, reason: e.reason }, END_TIMEOUT_MS)
    // The store reads follow run, so the script is not delayed by them.
    const resume = handoff?.state === 'ready' ? handoff.resume : await storedResume($, e.sessionId)
    if (resume !== undefined) {
      if (e.reason === 'clear') prefillAfterClear($, resume)
      else $.ui.status()
      await deleteStoredHandoff($, e.sessionId)
    }
    // The lookup follows run, so the script is not delayed, and follows forgetSession,
    // so transcriptPath checks the file system instead of the dropped cache.
    if (e.reason !== 'clear') clearedFrom = undefined
    else if (!clearedFrom) clearedFrom = e.sessionId
    else {
      // A root that cannot be read leaves clearedFrom as it is.
      const root = await $.session.root().catch(() => null)
      if (root && (await transcriptPath($, root, e.sessionId).catch(() => null))) clearedFrom = e.sessionId
    }
    const result = await next(e)
    await running
    if (e.reason === 'clear' || e.reason === 'resume') startReviews($)
    return result
  })

  // A turn that begins is working. turn.start has no agentId: a subagent's run raises
  // none.
  on('turn.start', async ($, e, next) => {
    await dropHandoff($)
    await track($, (a, now) => setState(a, 'working', now))
    return next(e)
  })

  // A turn that ends leaves the session waiting on the user, whatever the reason.
  // A subagent's turn that ends changes the subagent count. Its agentId goes into
  // endedAgents, so the count leaves it out even while $.agent.list() still reports
  // it running, and the file is rewritten. A main-thread turn that ends arms the
  // handoff timer.
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
      forgetAgentSteps(agentId)
      return result
    }
    await track($, (a, now) => {
      toolsOf(runningTools, a.sessionId).clear()
      a.tool = null
      setState(a, 'waiting', now)
    })
    try {
      armHandoff($, await $.session.id())
    } catch (err) {
      fail($, `handoff timer failed (${errorName(err)})`)
    }
    return next(e)
  })

  // Records the usage of each subagent model request for the dashboard (steps.ts).
  // The stream passes through unchanged. For a turn.step hook with no handler, a
  // throw or a budget overrun makes the engine run next(e) again, which sends a new
  // model request. So the recording after the stream catches everything and only
  // queues the write. This hook's .catch handler replays what its own next(e)
  // settled to, so no request is sent twice.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) yield chunk
    const result = await stream.result
    try {
      if (e.agentId && result.usage) queueStep($, e.agentId, stepOf(result.usage, await $.clock.now(), e.turnId, e.index))
    } catch (err) {
      fail($, `agent usage failed (${errorName(err)})`)
    }
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // Idle compaction reports trigger 'auto', as threshold compaction does. Threshold
  // compaction runs inside a turn, so only a main-thread session whose state is
  // waiting gets a handoff. The hook has 10 s of its own time and the fork takes
  // longer, so the fork is not awaited. A fork started here keeps running after the
  // hook returns, and it reads the conversation from before the compaction.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'auto' && !e.agentId) {
      try {
        const id = await $.session.id()
        if (activities.get(id)?.state === 'waiting' && !handoffs.has(id)) startHandoff($, id)
      } catch (err) {
        fail($, `handoff failed (${errorName(err)})`)
      }
    }
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
      toolsOf(runningTools, a.sessionId).set(id, run)
      a.tool = run
    })
    try {
      return await next(e)
    } finally {
      await track($, (a) => {
        const tools = toolsOf(runningTools, a.sessionId)
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

  // The plan limit band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, band)
    const shown = shownWindows(current.readings, current.levels)
    if (!shown.length) return next(e)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    return h(
      Box,
      { key: 'limit-band', gap: 1 },
      h(Text, { color: 'warning', wrap: 'truncate-end' }, bandText(shown, now)),
      h(Button, {
        key: 'dismiss-limits',
        label: 'Dismiss',
        role: 'dismiss',
        hotkey: 'd',
        onPress: () => {
          dismissBand($).catch((err) => fail($, `could not dismiss the limit band (${errorName(err)})`))
        },
      }),
    )
  })
}
