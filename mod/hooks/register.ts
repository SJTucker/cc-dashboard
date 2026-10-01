import type { EngineInterface, Register, SessionMeasureInput, SessionRateLimit } from 'claude-code'

// Records the dashboard's plan usage and session snapshots by running the scripts
// in bin/ that a statusline script used to run. The scripts stay the only writers,
// so the file formats, the atomic writes and the freshness checks are theirs.
//
// Only engine events are hooked. Claude Code's cc-plugin-sec-default skips every
// classic.* hook of an installed plugin, so classic SessionStart and SessionEnd
// never reach this module.

const MEASURE_TIMEOUT_MS = 5000
// session.end has 1.5 s for every hook and core together.
const END_TIMEOUT_MS = 1200

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

// No $ call returns the transcript's path. Claude Code keeps it at
// <config dir>/projects/<project dir, every character outside a-z, A-Z and 0-9
// replaced by '-'>/<session id>.jsonl. Null when neither variable is set.
async function transcriptPath($: EngineInterface, root: string, id: string) {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = configDir ? undefined : await $.env.get('HOME')
  if (!configDir && !home) return null
  return `${configDir ?? `${home}/.claude`}/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
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
  if (!transcript) return null
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

export const register: Register = (on) => {
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
}
