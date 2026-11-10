// Pure text helpers for the log and command messages in register.ts. Nothing here
// takes $.

import type { EngineInterface } from 'claude-code'

export type Judged = { asked: number; recorded: number; relevant: number; failed: string[] }

// The error's class name. A message can quote transcript text, as callScript notes,
// so most log lines use the name.
export const errorName = (err: unknown) => (err instanceof Error ? err.name : 'error')

export const errorText = (err: unknown) => (err instanceof Error ? err.message : 'error')

export const versionSpan = (versions: string[]) =>
  versions.length > 1 ? `${versions[0]}–${versions[versions.length - 1]}` : (versions[0] ?? '')

export function backfillText(judged: Judged) {
  if (!judged.asked && !judged.failed.length) return 'No Claude Code version needs a verdict.'
  const counts = `Judged ${judged.recorded} of ${judged.asked} versions, ${judged.relevant} relevant.`
  return judged.failed.length ? `${counts} Failed: ${judged.failed.join('; ')}` : counts
}

// Reads the contents of the updates file. A missing file (undefined) has no verdicts yet.
export function parseVerdicts(text: string | undefined): { verdicts: Record<string, unknown> } | { error: 'not-json' | 'not-object' } {
  if (text === undefined) return { verdicts: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'not-json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'not-object' }
  return { verdicts: parsed as Record<string, unknown> }
}

type ModelReply = Awaited<ReturnType<EngineInterface['model']['complete']>>

// The record bin/review-session takes for a Haiku reply: the text, or the reason there was none.
export function reviewOutcome(reply: ModelReply): { reply: string } | { error: string } {
  if (reply.isAnswered) return { reply: reply.text }
  const status = reply.reason === 'api-error' && reply.status !== null ? ` ${reply.status}` : ''
  return { error: `Haiku gave no answer (${reply.reason}${status})` }
}
