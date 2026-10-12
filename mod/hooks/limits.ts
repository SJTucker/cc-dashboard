// Levels and text for the plan limit band (limit-band.tsx). Nothing here takes $, so
// limits.test.ts calls these directly.

// The band shows at 75% and again at 90%. 75 must match LIMIT_WARN_PERCENT in
// public/constants.mjs, where the dashboard's "Nearing your plan limit" banner starts.
export const LIMIT_LEVELS = [75, 90] as const

export type WindowKind = 'five_hour' | 'seven_day'
export type Reading = { kind: WindowKind; percent: number; resetsAt?: string }
// The level each window was last dismissed at: 0, 75 or 90.
export type Levels = Record<WindowKind, number>

const KINDS: readonly WindowKind[] = ['five_hour', 'seven_day']
const NAMES: Record<WindowKind, string> = { five_hour: 'Session', seven_day: 'Week' }
const MINUTE_MS = 60_000

export const NO_LEVELS: Levels = { five_hour: 0, seven_day: 0 }

// The percent is rounded first, so the band agrees with the "N% used" the dashboard shows.
export function levelOf(percent: number): number {
  const rounded = Math.round(percent)
  let level = 0
  for (const l of LIMIT_LEVELS) if (rounded >= l) level = l
  return level
}

// The Session and Week windows of a session.measure reading, in that order.
export function readingsOf(limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Reading[] {
  const out: Reading[] = []
  for (const kind of KINDS) {
    const limit = limits.find((l) => l.kind === kind)
    if (!limit || !Number.isFinite(limit.percentUsed)) continue
    out.push(limit.resetsAt === undefined
      ? { kind, percent: limit.percentUsed }
      : { kind, percent: limit.percentUsed, resetsAt: limit.resetsAt })
  }
  return out
}

// limit-warnings.json as Levels. A missing or unreadable file, or a value other than
// 75 or 90, counts as 0.
export function parseLevels(text: string | undefined): Levels {
  let data: unknown = null
  try {
    if (text !== undefined) data = JSON.parse(text)
  } catch {
    data = null
  }
  const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const levels = { ...NO_LEVELS }
  for (const kind of KINDS) {
    const value = record[kind]
    if (typeof value === 'number' && (LIMIT_LEVELS as readonly number[]).includes(value)) levels[kind] = value
  }
  return levels
}

// A window that reads below the first level has reset, so its dismissal no longer applies.
export function resetLevels(readings: readonly Reading[], levels: Levels): Levels {
  const out = { ...levels }
  for (const r of readings) if (levelOf(r.percent) === 0) out[r.kind] = 0
  return out
}

export function shownWindows(readings: readonly Reading[], levels: Levels): Reading[] {
  return readings.filter((r) => levelOf(r.percent) > levels[r.kind])
}

export function dismissLevels(shown: readonly Reading[], levels: Levels): Levels {
  const out = { ...levels }
  for (const r of shown) out[r.kind] = Math.max(out[r.kind], levelOf(r.percent))
  return out
}

export function sameLevels(a: Levels, b: Levels): boolean {
  return KINDS.every((kind) => a[kind] === b[kind])
}

// Time until resetsAt, rounded up to the minute. Empty when resetsAt is missing,
// unreadable or past. A relative time needs no time zone, which the mod cannot read.
export function resetText(resetsAt: string | undefined, nowMs: number): string {
  const ms = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt)
  if (Number.isNaN(ms) || ms <= nowMs) return ''
  const minutes = Math.ceil((ms - nowMs) / MINUTE_MS)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`
  return `resets in ${minutes}m`
}

export function bandText(shown: readonly Reading[], nowMs: number): string {
  const parts = shown.map((r) => {
    const reset = resetText(r.resetsAt, nowMs)
    return `${NAMES[r.kind]} ${Math.round(r.percent)}%${reset ? ` (${reset})` : ''}`
  })
  return ['⚠ Nearing your plan limit', ...parts].join(' · ')
}
