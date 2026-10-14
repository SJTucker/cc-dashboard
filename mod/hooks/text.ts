// Pure text helpers for the log and command messages in register.ts. Nothing here
// takes $.

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
