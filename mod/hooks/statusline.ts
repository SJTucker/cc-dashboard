// Pure helpers for the statusline record in register.ts. Nothing here takes $.
import type { SessionRateLimit } from 'claude-code'

export type Frozen<T> = { readonly [K in keyof T]: T[K] }
export type Window = { used_percentage: number; resets_at?: number }

// $.session.model() returns the model id, and the statusline sent a display name,
// which the Live sessions panel shows: claude-opus-5-5[1m] is "Opus 5.5 (1M
// context)" and claude-haiku-4-5-20251001 is "Haiku 4.5". Any other form is sent
// as it is.
export function displayName(id: string) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!match) return id
  const [, family = '', version = '', oneMillion] = match
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replace(/-/g, '.')}`
  return oneMillion ? `${name} (1M context)` : name
}

// The statusline sends resets_at as epoch seconds, and lib/limits.js reads it that
// way. session.measure sends an ISO timestamp.
export function toWindow(limit: Frozen<SessionRateLimit>): Window {
  const ms = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return Number.isNaN(ms)
    ? { used_percentage: limit.percentUsed }
    : { used_percentage: limit.percentUsed, resets_at: Math.floor(ms / 1000) }
}

// Only the two windows the statusline JSON has. A gateway's spend_limit is left out.
export function rateLimitsInput(limits: readonly Frozen<SessionRateLimit>[]): Record<string, Window> | undefined {
  const out: Record<string, Window> = {}
  for (const limit of limits) {
    if (limit.kind === 'five_hour' || limit.kind === 'seven_day') out[limit.kind] = toWindow(limit)
  }
  return Object.keys(out).length ? out : undefined
}

export type StatuslineFields = {
  id: string
  launchId: string
  transcript: string
  root: string
  modelId: string
  clearedFrom: string | undefined
  // startedAt is the session's start and now is the clock when the cost was read.
  cost: { usd: number; startedAt: number; now: number } | undefined
  rateLimits: Record<string, Window> | undefined
}

// The record bin/record-statusline reads, in the shape of the statusLine command's
// JSON. cleared_from is set only when it names another session than this one.
export function statuslineRecord(f: StatuslineFields) {
  const input: Record<string, unknown> = {
    session_id: f.id,
    launch_id: f.launchId,
    transcript_path: f.transcript,
    workspace: { project_dir: f.root },
    model: { display_name: displayName(f.modelId) },
  }
  if (f.clearedFrom && f.clearedFrom !== f.id) input.cleared_from = f.clearedFrom
  if (f.cost) {
    input.cost = { total_cost_usd: f.cost.usd, total_duration_ms: Math.max(0, f.cost.now - f.cost.startedAt) }
  }
  if (f.rateLimits) input.rate_limits = f.rateLimits
  return input
}

// Claude Code keeps a session's transcript under projects/<folder>/, where <folder>
// is the session's directory with every character outside a-z, A-Z and 0-9 replaced
// by '-'.
export const projectFolder = (root: string) => root.replace(/[^a-zA-Z0-9]/g, '-')
