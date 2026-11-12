// Pure helpers for the handoff modes. They take no $, so register.ts does the
// lookups, the commands and the engine calls, and these build the texts.
//
// Transcript fallback: resumePrompt is the prompt prefilled after /clear when no
// document or image could be made, or the cache had expired. It follows the
// no-compaction gist: it points Claude at the session's own transcript .jsonl instead
// of a summary.
// Image mode: planImage and imageDocument build the fork prompt and the file the fork's
// reply is saved to under .claude/context-images/, and imageResumePrompt is the prefill.
// The prompt adapts skills/orchestrate/image-template.md for one session resuming its
// own work.
// Document mode: REPO_STEPS, planHandoff and handoffDocument build the fork prompt and
// the file the fork's reply is saved to, and documentResumePrompt is the prefill. The
// commands and the document structure follow the /handoff skill. The mod carries its
// own copy because other users of the dashboard do not have that skill.
// hourCacheExpiry and handoffWaitMs time any handoff for a 1h prompt cache.

const TIPS =
  'Tips:\n' +
  '- Each line is one JSON message, some with huge tool results: never cat or tail it raw, ' +
  'cap each block to a few hundred chars.\n'

// The path unchanged when it holds only [A-Za-z0-9_./~-], else single-quoted with each
// embedded ' written as '\''. A path with a space then reads as one argument.
export function quotePath(path: string) {
  return /^[A-Za-z0-9_./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`
}

// The prompt the mod puts in the input box after /clear. index is the transcript's
// index file from bin/transcript-index, passed only when it exists.
export function resumePrompt(path: string, index?: string) {
  const start = index
    ? `Start with its index, ${quotePath(index)}. It lists each prompt the user typed with the transcript lines it covers, ` +
      'the files touched, the commands run and the subagents launched. Then read only the line ranges you need.\n\n'
    : ''
  return (
    `Read ${quotePath(path)}, the transcript of an earlier Claude Code session, to find what it was working on, ` +
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
  return `Read ${quotePath(path)}, check Preconditions, then continue from "Next steps".`
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

// The handoff to make at fire time. A document or image handoff forks the conversation,
// and a fork sent after the 1h cache expired re-sends the whole conversation uncached.
// At or past expiresAt the transcript handoff is made instead, which costs no model call.
export function handoffKind(mode: 'document' | 'image', expiresAt: number, now: number): 'document' | 'image' | 'transcript' {
  return expiresAt <= now ? 'transcript' : mode
}

// The handoff entry a session.end fills in for the next session: only after a /clear,
// the reset entry first, else the stored one when handoff is on.
export function endFill(reason: string, reset: string | undefined, stored: string | undefined, handoffOn: boolean): string | undefined {
  return reason === 'clear' ? (reset ?? (handoffOn ? stored : undefined)) : undefined
}

// The fork prompt for a context image. Adapted from skills/orchestrate/image-template.md:
// one session writes the image for its own resumption, so the worker protocol, board
// and updates sections are gone. The fork has no tools, so the reply is the document.
const IMAGE_INSTRUCTIONS = `Write a context image that lets this same work resume in a fresh session after /clear. The reader has the repo, the files the image lists, the session's transcript and its index, and cannot ask you questions.

You have no tools in this reply. Write from what you already know from this conversation and from the transcript index below. Do not paste diffs. Reply with the document only, in Markdown, starting with the line "# Context image: <the task, in at most 6 words>". Write no preamble and no code fence around the reply. Keep it under 4,000 words, and cut anything the reader can read from a file instead.

If the Worktree root step failed, this is not a git repo. Describe the changed files from the conversation. Another failed step means only that its output is missing.

Use this structure, with these section headings in this order. A section with nothing to say gets "None."

# Context image: <the task, in at most 6 words>

## Sources
Absolute paths: the session's transcript and its transcript index (both given below).

## Goal and principles
The user's own messages that state intent, constraints or corrections, quoted verbatim, each as "> text" followed on the next line by "(line N)". N is a transcript line number, taken from the turn headings of the transcript index. Review every user prompt in the index and sort it into one of three:
- Quote: it states intent, a constraint, a correction or a decision.
- Conclusion only: it was part of a back-and-forth whose outcome is a decision you record elsewhere. Nothing from it is quoted.
- Leave out: a go-ahead ("yes", "go on"), chatter about the harness, something a later message replaced, or a message the user asked to keep out.
Do the review from the index, not from memory: the index lists every message.

## Read before starting
An ordered list of files the next session reads in full, each with one line on why: the project's CLAUDE.md, any spec or plan, then the source files the work centers on and their immediate call paths. Absolute paths.

## Decisions
Each decision, the alternatives rejected and the transcript line range where it was made. Quote the user's message verbatim when it only makes the decision. When that message is already quoted in Goal and principles, refer to its line.

## Dead ends
What was tried and failed, and why, with each error quoted verbatim, so it is not tried again.

## Orientation
Where things live, naming conventions, and the exact commands that check the work: test commands, lint, type checks, with the real runner instead of a package-script alias.

## Environment
The branch and worktree path, ports, databases, and the rule that every command runs in that worktree.

## Done
What changed, each with the file it lives in, marked as verified, written but untested, or partly applied.

## In progress
The exact thing being worked on, with file and line. If an edit is half applied or a file is broken, say so first.

## Next steps
Ordered and concrete. The first step can be done at once. Give the exact command where there is one.

## Left out
One line per user message left out of Goal and principles: its transcript line number, its first few words and why it was left out. A left-out message is quoted nowhere else in the image.

## Lookup
For anything not in this image, search the transcript through its index. Fill in both paths:

The transcript index lists each turn of the session with the transcript lines it covers: <index path>.

Never read the transcript whole: one line can hold a huge tool result. Print a range with each line cut to 400 characters:

    sed -n 'A,Bp' '<transcript path>' | cut -c1-400

Find one record by the uuid in a turn heading:

    grep -n '"uuid":"<uuid>"' '<transcript path>'

Writing rules:
- Do not refer to the conversation, as in "the fix we discussed". Name the thing.
- Give paths with line numbers, not descriptions.
- Quote errors verbatim.
- Label each claim as verified, believed or suspected.
- Never invent. If you are unsure whether something was applied, write "unverified, check git diff for this file".

Repo state when this was written:`

// The fork prompt and the file path for a context image, or null when date gave no
// usable timestamp. transcript is the session's transcript path and index the path of
// its transcript index, which indexText holds. Either may be absent: the prompt then
// says so instead of giving a path. The folder is separate from .claude/handoffs/.
export function planImage(
  outputs: StepOutput[],
  cwd: string,
  transcript: string | undefined,
  index: string | undefined,
  indexText: string | undefined,
): { prompt: string; path: string } | null {
  const stamp = stepText(outputs, 'Timestamp')
  if (!stamp || !STAMP.test(stamp)) return null
  const root = (stepText(outputs, 'Worktree root') ?? cwd).replace(/\/+$/, '')
  const sources =
    `Transcript path: ${transcript ? quotePath(transcript) : '(not found)'}\n` +
    `Transcript index path: ${index ? quotePath(index) : '(no index exists)'}`
  const indexPart = indexText?.trim()
    ? `Transcript index (${index ?? 'unknown path'}):\n\n${indexText.trim()}`
    : 'No transcript index exists for this session. Leave out the line numbers and say so in Goal and principles.'
  return {
    prompt: `${IMAGE_INSTRUCTIONS}\n\n${repoText(outputs)}\n\n${sources}\n\n${indexPart}`,
    path: `${root}/.claude/context-images/${stamp}-${branchSlug(stepText(outputs, 'Branch'))}.md`,
  }
}

// The file's text, from the fork's reply, like handoffDocument but for the
// "# Context image:" heading.
export function imageDocument(text: string): string | null {
  const at = text.search(/(?<!#)# Context image:/)
  const doc = (at > 0 ? text.slice(at) : text).trim()
  return doc ? `${doc}\n` : null
}

// The prompt the mod puts in the input box after /clear in image mode.
export function imageResumePrompt(path: string) {
  return `Read ${quotePath(path)} in full, then every file it lists under "Read before starting". Continue from "Next steps".`
}
