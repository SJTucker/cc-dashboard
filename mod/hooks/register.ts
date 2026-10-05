import type { EngineInterface, Register, SessionMeasureInput, SessionRateLimit } from 'claude-code'

// Records the dashboard's plan usage and session snapshots by running the scripts
// in bin/ that a statusline script used to run, and judges new Claude Code releases
// for the setup changes markers through bin/judge-updates. The scripts stay the only
// writers, so the file formats, the atomic writes and the freshness checks are theirs.
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
const MODEL_TIMEOUT_MS = 60_000

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
  $.ui.log(`cc-dashboard: ${text}`)
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
    fail($, 'transcript not found')
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

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'error')

// Every update failure is logged. They happen at most once per Claude Code release,
// so the once-only rule in fail() would hide the one that matters.
function note($: EngineInterface, text: string) {
  $.ui.log(`cc-dashboard: ${text}`)
}

async function judgeScript($: EngineInterface, args: string[], stdin: string, timeoutMs: number): Promise<unknown> {
  const { exitCode, stdout, stderr } = await $.process.run([await scriptPath($, 'judge-updates'), ...args], { stdin, timeoutMs })
  if (exitCode !== 0) throw new Error(`judge-updates ${args[0]} failed (exit ${exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`)
  return JSON.parse(stdout)
}

const versionSpan = (versions: string[]) =>
  versions.length > 1 ? `${versions[0]}–${versions[versions.length - 1]}` : (versions[0] ?? '')

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
    batches = ((await judgeScript($, args, changelog, PROMPT_TIMEOUT_MS)) as { batches: Batch[] }).batches
  } catch (err) {
    judged.failed.push(err instanceof Error ? err.message : 'judge-updates prompt failed')
    return judged
  }
  for (const batch of batches) {
    judged.asked += batch.versions.length
    const reply = await $.model.complete({
      model: 'haiku',
      system: batch.system,
      prompt: batch.prompt,
      maxTokens: 2048,
      effort: 'low',
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    if (!reply.isAnswered) {
      judged.failed.push(`Haiku gave no verdict for ${versionSpan(batch.versions)} (${reply.reason})`)
      continue
    }
    try {
      const input = JSON.stringify({ versions: batch.versions, reply: reply.text })
      const out = (await judgeScript($, ['record'], input, RECORD_TIMEOUT_MS)) as { recorded: number; relevant: number }
      judged.recorded += out.recorded
      judged.relevant += out.relevant
    } catch (err) {
      judged.failed.push(err instanceof Error ? err.message : 'judge-updates record failed')
    }
  }
  return judged
}

// Runs once per session start, after the session is up. Only the running version
// is looked up here; /backfill-updates covers the versions before it.
async function checkVersion($: EngineInterface) {
  const { base } = await $.session.version()
  if (!base || !RELEASE.test(base)) return // a dev build has no changelog entry
  const dir = await configDir($)
  if (!dir) return
  const file = `${dir}/cc-dashboard/updates.json`
  // A read that fails means no verdicts yet: the file is written on the first one.
  const text = await $.fs.read(file).then(String, () => undefined)
  let verdicts: Record<string, unknown> = {}
  if (text !== undefined) {
    try {
      verdicts = JSON.parse(text) as Record<string, unknown>
    } catch {
      note($, `${file} is not valid JSON; fix or delete it`)
      return
    }
  }
  if (Object.hasOwn(verdicts, base)) return
  const judged = await judgeUpdates($, base)
  for (const failure of judged.failed) note($, failure)
}

function backfillText(judged: Judged) {
  if (!judged.asked && !judged.failed.length) return 'Every Claude Code version in the transcripts already has a verdict.'
  const counts = `Judged ${judged.recorded} of ${judged.asked} versions, ${judged.relevant} relevant.`
  return judged.failed.length ? `${counts} Failed: ${judged.failed.join('; ')}` : counts
}

export const register: Register = (on) => {
  // Registers /backfill-updates and checks whether the running Claude Code version
  // has a verdict. The check runs from a timer, after session start returns, because
  // session.start is awaited before the first prompt.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'backfill-updates',
      description: 'Judge every Claude Code version in the transcripts for changes that could affect usage',
    }).catch(() => undefined)
    const result = await next(e)
    $.clock.after(0, () => {
      checkVersion($).catch((err) => note($, `update check failed (${errorName(err)})`))
    })
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
  // with reason 'clear'.
  on('session.end', async ($, e, next) => {
    // The script starts before next, so it does not wait for the other hooks.
    // run never throws.
    const running = run($, 'record-session-end', { session_id: e.sessionId, reason: e.reason }, END_TIMEOUT_MS)
    const result = await next(e)
    await running
    return result
  })
}
