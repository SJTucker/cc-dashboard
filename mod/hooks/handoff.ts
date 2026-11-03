// Pure helpers for the transcript handoff. They take no $, so register.ts does the
// lookups and the engine calls, and these build the texts. resumePrompt is the prompt
// prefilled after /clear. handoffText is what /transcript-handoff prints.
// hourCacheExpiry and handoffWaitMs time the handoff for a 1h prompt cache.
//
// The prompt text follows the no-compaction gist: it points Claude at the session's
// own transcript .jsonl instead of a summary.

const TIPS =
  'Tips:\n' +
  '- Each line is one JSON message, some with huge tool results: never cat or tail it raw, ' +
  'cap each block to a few hundred chars.\n'

// The prompt the mod puts in the input box after /clear.
export function resumePrompt(path: string) {
  return (
    `Read ${path}, the transcript of an earlier Claude Code session, to find what it was working on, ` +
    'and continue from where it stopped.\n\n' +
    TIPS +
    '- The end shows where it stopped; the first user messages show the goal.'
  )
}

// What /transcript-handoff prints: the command that starts a fresh session in cwd, a blank line,
// then the resume prompt. cwd is single-quoted when it holds a character outside
// [A-Za-z0-9_./~-], with each embedded ' written as '\''.
export function handoffText(cwd: string, path: string) {
  const dir = /^[A-Za-z0-9_./~-]+$/.test(cwd) ? cwd : `'${cwd.replace(/'/g, "'\\''")}'`
  return `cd ${dir} && claude\n\n${resumePrompt(path)}\n- The last lines are the /transcript-handoff command that produced this prompt, so skip them.`
}

// The expiry time of a 1h prompt cache, from the output of bin/cache-state. Null for
// any other TTL or a missing or non-numeric expiresAt.
export function hourCacheExpiry(cache: { ttl?: unknown; expiresAt?: unknown }): number | null {
  return cache.ttl === '1h' && typeof cache.expiresAt === 'number' ? cache.expiresAt : null
}

// Milliseconds from now until the handoff timer fires, leadMs before the cache
// expires. A timer armed or re-checked after that moment gets 0, so it fires at once.
export function handoffWaitMs(expiresAt: number, now: number, leadMs: number) {
  return Math.max(0, expiresAt - leadMs - now)
}
