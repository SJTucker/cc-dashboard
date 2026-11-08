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

// The prompt the mod puts in the input box after /clear. index is the transcript's
// index file from bin/transcript-index, passed only when it exists.
export function resumePrompt(path: string, index?: string) {
  const start = index
    ? `Start with its index, ${index}. It lists each prompt the user typed with the transcript lines it covers, ` +
      'the files touched, the commands run and the subagents launched. Then read only the line ranges you need.\n\n'
    : ''
  return (
    `Read ${path}, the transcript of an earlier Claude Code session, to find what it was working on, ` +
    'and continue from where it stopped.\n\n' +
    start +
    TIPS +
    '- The end shows where it stopped; the first user messages show the goal.'
  )
}

// Where bin/transcript-index writes the index of a session's transcript.
export function indexPath(configDir: string, sessionId: string) {
  return `${configDir}/cc-dashboard/transcript-index/${sessionId}.md`
}

// What /transcript-handoff prints: the command that starts a fresh session in cwd, a blank line,
// then the resume prompt. cwd is single-quoted when it holds a character outside
// [A-Za-z0-9_./~-], with each embedded ' written as '\''.
export function handoffText(cwd: string, path: string, index?: string) {
  const dir = /^[A-Za-z0-9_./~-]+$/.test(cwd) ? cwd : `'${cwd.replace(/'/g, "'\\''")}'`
  return `cd ${dir} && claude\n\n${resumePrompt(path, index)}\n- The last lines are the /transcript-handoff command that produced this prompt, so skip them.`
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
