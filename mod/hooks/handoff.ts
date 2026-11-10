// Pure helpers for the two handoff modes. They take no $, so register.ts does the
// lookups, the commands and the engine calls, and these build the texts.
//
// Transcript mode: resumePrompt is the prompt prefilled after /clear, and handoffText
// is what /transcript-handoff prints. It follows the no-compaction gist: it points
// Claude at the session's own transcript .jsonl instead of a summary.
// Document mode: REPO_STEPS, planHandoff and handoffDocument build the fork prompt and
// the file the fork's reply is saved to, and documentResumePrompt is the prefill. The
// commands and the document structure follow the /handoff skill. The mod carries its
// own copy because other users of the dashboard do not have that skill.
// hourCacheExpiry and handoffWaitMs time either handoff for a 1h prompt cache.

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

// The commands the /handoff skill runs for its "Live repo state", plus date for the
// file name. date gives local time, which matches the names the skill writes, so
// handoffs from both sort together in one folder.
export const REPO_STEPS = [
  { label: 'Worktree root', argv: ['git', 'rev-parse', '--show-toplevel'] },
  { label: 'Branch', argv: ['git', 'branch', '--show-current'] },
  { label: 'HEAD', argv: ['git', 'log', '-1', '--format=%h %s'] },
  { label: 'All worktrees', argv: ['git', 'worktree', 'list'] },
  { label: 'Working tree', argv: ['git', 'status', '--short'] },
  { label: 'Changes vs HEAD', argv: ['git', 'diff', '--stat', 'HEAD'] },
  { label: 'Recent commits', argv: ['git', 'log', '--oneline', '-15'] },
  { label: 'Stashes', argv: ['git', 'stash', 'list'] },
  { label: 'Timestamp', argv: ['date', '+%Y-%m-%d-%H%M%S'] },
] as const

// One command's result. text is stdout when the command succeeded and stderr when it
// failed, trimmed either way.
export type StepOutput = { label: string; ok: boolean; text: string }

const STAMP = /^\d{4}-\d{2}-\d{2}-\d{6}$/
const SLUG_MAX = 60

// The fork runs with every tool denied and two turns at most, so the instructions
// ask for the document as the reply instead of a file write.
const INSTRUCTIONS = `Write a handoff document that lets an agent with zero conversation history resume the work in this conversation. The reader has the repo and nothing else, and cannot ask you questions.

You have no tools in this reply. Write from what you already know from this conversation. Do not paste diffs. Reply with the document only, in Markdown, starting with the line "# Handoff: <the task, in at most 6 words>". Write no preamble and no code fence around the reply.

If the Worktree root step failed, this is not a git repo. Leave out the Git state section and describe the changed files from the conversation. Another failed step means only that its output is missing.

Use this structure. Leave out any section that would be empty.

The heading names the task in at most 6 words. The dashboard shows it as the title of the session that picks up the handoff. Put status, PR numbers in flight and what is waiting under "## Status", not in the heading.

# Handoff: <the task, in at most 6 words>

**Written:** <timestamp from the repo state>

## Preconditions
Check these before doing anything else. If any fails, stop and tell the user you may be in the wrong place instead of resuming.
- Worktree: \`<absolute worktree root>\`
- Branch: \`<branch>\`
- HEAD when written: \`<short sha> <subject>\`
- Sibling worktrees: \`<list, or "none">\`
Verify with \`git rev-parse --show-toplevel && git branch --show-current\`. A different HEAD is fine, because someone may have committed since. A different worktree or branch means this handoff is not for you.

## Goal
What the work is trying to accomplish and why, in the user's terms. One short paragraph.

## Status
Where things stand. Say plainly what is complete and what is not.

## Done
What changed, each with the file it lives in, marked as verified, written but untested, or partly applied.

## In progress
The exact thing being worked on, with file and line. If an edit is half applied or a file is broken, say so first.

## Next steps
Ordered and concrete. The first step can be done at once. Give the exact command where there is one, and name the real runner instead of a package-script alias.

## Decisions and constraints
Choices made and why, alternatives rejected and why, and hard constraints the user set.

## Dead ends
Approaches tried that failed, with each error quoted verbatim.

## Orientation
The 3 to 8 files that matter, one line each.

## Verify
Exact commands to build, run and test, and what currently passes and fails.

## Open questions
Anything waiting on the user, with your recommendation.

## Git state
Uncommitted files, stashes named by message rather than index (stashes are shared across worktrees), and anything unusual.

Writing rules:
- Do not refer to the conversation, as in "the fix we discussed". Name the thing.
- Give paths with line numbers, not descriptions.
- Quote errors verbatim.
- Label each claim as verified, believed or suspected.
- Never invent. If you are unsure whether something was applied, write "unverified, check git diff for this file".
- Size the document to the work: about 40 lines for a small fix, up to 200 for a long task.

Repo state when this was written:`

// The step's text when it succeeded with output, otherwise null.
function stepText(outputs: StepOutput[], label: string) {
  const step = outputs.find((o) => o.label === label)
  return step?.ok && step.text ? step.text : null
}

// The branch as a file-name part: lowercase, each run of other characters one dash,
// at most SLUG_MAX characters. An empty branch, which a detached HEAD or a folder
// outside git gives, becomes no-branch.
export function branchSlug(branch: string | null) {
  const slug = (branch ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  return slug || 'no-branch'
}

// The text the mod puts in the input box after /clear in document mode. It names the
// handoff file and the sections the next agent reads first.
export function documentResumePrompt(path: string) {
  return `Read ${path}, check Preconditions, then continue from "Next steps".`
}

// The repo state in the fork prompt: one heading per step, with the output, or the
// error text marked (failed) when the step failed.
function repoText(outputs: StepOutput[]) {
  return outputs
    .map((o) => `### ${o.label}\n${o.ok ? o.text || '(none)' : `(failed) ${o.text}`}`)
    .join('\n\n')
}

// The fork prompt and the file path, or null when date gave no usable timestamp,
// because the file name needs one.
export function planHandoff(outputs: StepOutput[], cwd: string): { prompt: string; path: string } | null {
  const stamp = stepText(outputs, 'Timestamp')
  if (!stamp || !STAMP.test(stamp)) return null
  const root = (stepText(outputs, 'Worktree root') ?? cwd).replace(/\/+$/, '')
  return {
    prompt: `${INSTRUCTIONS}\n\n${repoText(outputs)}`,
    path: `${root}/.claude/handoffs/${stamp}-${branchSlug(stepText(outputs, 'Branch'))}.md`,
  }
}

// The file's text, from the fork's reply. The reply joins all the fork's text
// blocks with a single space, so a preamble block followed by the document block puts
// the heading mid-line. Anything before the first "# Handoff:" is dropped, except
// where a "#" comes right before it, which is a "## Handoff:" sub-heading. A reply
// without that heading is kept whole, because it may still be a usable document. A
// blank reply gives null.
export function handoffDocument(text: string): string | null {
  const at = text.search(/(?<!#)# Handoff:/)
  const doc = (at > 0 ? text.slice(at) : text).trim()
  return doc ? `${doc}\n` : null
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

// The handoff to make at fire time. A document handoff forks the conversation, and a
// fork sent after the 1h cache expired re-sends the whole conversation uncached. At or
// past expiresAt the transcript handoff is made instead, which costs no model call.
export function handoffKind(mode: 'document' | 'transcript', expiresAt: number, now: number): 'document' | 'transcript' {
  return expiresAt <= now ? 'transcript' : mode
}
