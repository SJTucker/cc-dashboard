import { resetText } from './limits'

// The 5-hour pace from the readings that recordRateLimits (lib/limits.js) caches in
// rate-limits.json. lib/pace.js holds the same math for the server, and both copies
// run the same test table. Nothing here takes `$`.

export type PaceEntry = { t: number; percent: number; sessionId: string | null }
export type Pace = {
  state: 'idle' | 'steady' | 'fast'
  percent: number
  ratePerHour: number
  fastPerHour: number
  runsOutAt: number | null
  busySessionId: string | null
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const SPAN_MS = 15 * MINUTE_MS
const MARGIN_MS = 60 * MINUTE_MS
const MIN_RISE = 6
const MIN_GAP_MS = 3 * MINUTE_MS

function isEntry(e: unknown): e is { t: number; percent: number; sessionId?: unknown } {
  if (typeof e !== 'object' || e === null) return false
  const x = e as Record<string, unknown>
  return typeof x.t === 'number' && Number.isFinite(x.t) && typeof x.percent === 'number' && Number.isFinite(x.percent)
}

// claudeJsonText is the text of .claude.json. When both it and the file name an account and
// the two differ, the list belongs to the previous login and is ignored, as parseUsageCache
// does in limits.ts.
export function parsePaceCache(text: string | undefined, claudeJsonText?: string): { recent: PaceEntry[]; resetsAt: number } | null {
  if (text === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const file = parsed as Record<string, unknown>
  if (typeof file.accountUuid === 'string' && claudeJsonText !== undefined) {
    let login: unknown
    try {
      login = (JSON.parse(claudeJsonText) as { oauthAccount?: { accountUuid?: unknown } } | null)?.oauthAccount?.accountUuid
    } catch {
      login = undefined
    }
    if (typeof login === 'string' && login !== file.accountUuid) return null
  }
  const resetsAt = file.fiveHourResetsAt
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  const list = Array.isArray(file.fiveHourRecent) ? file.fiveHourRecent : []
  const recent: PaceEntry[] = []
  for (const e of list) {
    if (!isEntry(e)) continue
    recent.push({ t: e.t, percent: e.percent, sessionId: typeof e.sessionId === 'string' ? e.sessionId : null })
  }
  return { recent, resetsAt }
}

export function parseSessionProject(text: string | undefined): string | null {
  if (text === undefined) return null
  try {
    const project = (JSON.parse(text) as { project?: unknown } | null)?.project
    return typeof project === 'string' && project ? project : null
  } catch {
    return null
  }
}

// resetsAt is epoch seconds, nowMs is epoch ms. Null when the window is spent or has reset.
export function computePace(recent: readonly PaceEntry[], resetsAt: number, nowMs: number): Pace | null {
  if (recent.length === 0) return null
  // Entries arrive oldest first (addReading keeps arrival order for equal t), as in lib/pace.js.
  const percent = recent[recent.length - 1].percent
  const untilResetMs = resetsAt * 1000 - nowMs
  if (percent >= 100 || untilResetMs <= 0) return null

  const margin = Math.min(MARGIN_MS, untilResetMs / 2)
  const fastPerHour = (100 - percent) / ((untilResetMs - margin) / HOUR_MS)

  const span = recent.filter((e) => e.t >= nowMs - SPAN_MS && e.t <= nowMs)
  const counts = new Map<string, { n: number; last: number }>()
  for (const e of span) {
    if (!e.sessionId) continue
    const c = counts.get(e.sessionId) ?? { n: 0, last: -Infinity }
    counts.set(e.sessionId, { n: c.n + 1, last: Math.max(c.last, e.t) })
  }
  let busySessionId: string | null = null
  let best: { n: number; last: number } | null = null
  for (const [id, c] of counts) {
    if (best === null || c.n > best.n || (c.n === best.n && c.last > best.last)) {
      busySessionId = id
      best = c
    }
  }
  const idle: Pace = { state: 'idle', percent, ratePerHour: 0, fastPerHour, runsOutAt: null, busySessionId }
  if (span.length < 2) return idle
  const oldest = span[0]
  const newest = span[span.length - 1]
  const rise = newest.percent - oldest.percent
  const ms = nowMs - oldest.t
  if (rise <= 0 || ms <= 0) return idle

  const ratePerHour = (rise * HOUR_MS) / ms
  const runsOutAt = ratePerHour > 0 ? nowMs + ((100 - percent) / ratePerHour) * HOUR_MS : null
  const fast = ratePerHour > fastPerHour && rise >= MIN_RISE && newest.t - oldest.t >= MIN_GAP_MS

  return { state: fast ? 'fast' : 'steady', percent, ratePerHour, fastPerHour, runsOutAt, busySessionId }
}

// A relative time needs no time zone, which the mod cannot read.
function durationText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export function paceText(pace: Pace, resetsAt: number, nowMs: number, ownSessionId: string, busyProject: string | null): string {
  const reset = resetText(new Date(resetsAt * 1000).toISOString(), nowMs)
  const out = pace.runsOutAt === null ? '' : ` to run out in ${durationText(pace.runsOutAt - nowMs)}`
  let text = `⚠ 5h window: on pace${out}${reset ? ` (${reset})` : ''}`
  if (pace.busySessionId === ownSessionId) text += ' · fastest: this session'
  else if (pace.busySessionId !== null && busyProject !== null) text += ` · fastest: a session in ${busyProject}`
  return text
}
