import { test, expect } from 'claude-code/testing'
import {
  REPO_STEPS, endFill, branchSlug, documentResumePrompt, handoffDocument, handoffKind, handoffWaitMs, hourCacheExpiry, imageDocument, imageResumePrompt, indexPath, planHandoff, planImage, quotePath, resumePrompt,
} from './handoff'
import type { StepOutput } from './handoff'

const PATH = '/home/u/.claude/projects/-work-demo/s1.jsonl'

test('resumePrompt names the transcript and has no command tip', async () => {
  const text = resumePrompt(PATH)
  expect(text).toContain(`Read ${PATH}, the transcript of an earlier Claude Code session`)
  expect(text).toContain('- The end shows where it stopped; the first user messages show the goal.')
  expect(text).not.toContain('-handoff')
})

test('hourCacheExpiry gives the expiry of a 1h cache and null for anything else', async () => {
  expect(hourCacheExpiry({ ttl: '1h', expiresAt: 5 })).toBe(5)
  expect(hourCacheExpiry({ ttl: '5m', expiresAt: 5 })).toBe(null)
  expect(hourCacheExpiry({ ttl: '1h' })).toBe(null)
  expect(hourCacheExpiry({ ttl: '1h', expiresAt: '5' })).toBe(null)
})

test('handoffWaitMs is the time until leadMs before expiry, and 0 once that has passed', async () => {
  expect(handoffWaitMs(10_000, 1_000, 6_000)).toBe(3_000)
  expect(handoffWaitMs(10_000, 4_000, 6_000)).toBe(0)
  expect(handoffWaitMs(10_000, 5_000, 6_000)).toBe(0)
})

test('indexPath puts the index under cc-dashboard/transcript-index', async () => {
  expect(indexPath('/home/u/.claude', 's1')).toBe('/home/u/.claude/cc-dashboard/transcript-index/s1.md')
})

const INDEX = '/home/u/.claude/cc-dashboard/transcript-index/s1.md'

test('resumePrompt with an index tells the session to start with it', async () => {
  const text = resumePrompt(PATH, INDEX)
  expect(text).toContain(`Start with its index, ${INDEX}.`)
  expect(text).toContain('Then read only the line ranges you need.')
  expect(text.startsWith(`Read ${PATH}, the transcript of an earlier Claude Code session`)).toBe(true)
})

test('resumePrompt with no index is unchanged', async () => {
  expect(resumePrompt(PATH, undefined)).toBe(resumePrompt(PATH))
  expect(resumePrompt(PATH)).not.toContain('index')
})

const ok = (label: string, text: string): StepOutput => ({ label, ok: true, text })
const failed = (label: string, text: string): StepOutput => ({ label, ok: false, text })
const repo = (over: StepOutput[] = []): StepOutput[] => {
  const base = [
    ok('Worktree root', '/work/demo'),
    ok('Branch', 'feat/Handoff X'),
    ok('HEAD', 'abc1234 feat: thing'),
    ok('All worktrees', '/work/demo  abc1234 [feat/Handoff X]'),
    ok('Working tree', ' M mod/hooks/register.ts'),
    ok('Changes vs HEAD', ' mod/hooks/register.ts | 4 ++--'),
    ok('Recent commits', 'abc1234 feat: thing'),
    ok('Stashes', ''),
    ok('Timestamp', '2026-10-12-154500'),
  ]
  return base.map((step) => over.find((o) => o.label === step.label) ?? step)
}

test('REPO_STEPS runs the skill\'s git commands and date, each with a label', async () => {
  expect(REPO_STEPS.map((s) => s.argv.join(' '))).toEqual([
    'git rev-parse --show-toplevel',
    'git branch --show-current',
    'git log -1 --format=%h %s',
    'git worktree list',
    'git status --short',
    'git diff --stat HEAD',
    'git log --oneline -15',
    'git stash list',
    'date +%Y-%m-%d-%H%M%S',
  ])
  expect(new Set(REPO_STEPS.map((s) => s.label)).size).toBe(REPO_STEPS.length)
})

test('branchSlug lowercases and joins runs of other characters with one dash', async () => {
  expect(branchSlug('feat/Handoff X')).toBe('feat-handoff-x')
  expect(branchSlug('fix/ünïcode--name')).toBe('fix-n-code-name')
  expect(branchSlug('/leading/and/trailing/')).toBe('leading-and-trailing')
})

test('branchSlug gives no-branch for an empty, missing or all-symbol branch', async () => {
  expect(branchSlug('')).toBe('no-branch')
  expect(branchSlug(null)).toBe('no-branch')
  expect(branchSlug('///')).toBe('no-branch')
})

test('branchSlug keeps at most 60 characters and no trailing dash', async () => {
  const slug = branchSlug(`${'a'.repeat(59)}/bbb`)
  expect(slug).toBe('a'.repeat(59))
  expect(branchSlug('x'.repeat(100)).length).toBe(60)
})

test('documentResumePrompt names the file and the two sections to read', async () => {
  expect(documentResumePrompt('/work/demo/.claude/handoffs/2026-10-12-154500-main.md')).toBe(
    'Read /work/demo/.claude/handoffs/2026-10-12-154500-main.md, check Preconditions, then continue from "Next steps".',
  )
})

test('planHandoff puts the file under the worktree root with the timestamp and slug', async () => {
  const plan = planHandoff(repo(), '/work/demo/sub')
  expect(plan?.path).toBe('/work/demo/.claude/handoffs/2026-10-12-154500-feat-handoff-x.md')
})

test('planHandoff falls back to cwd and no-branch outside a git repo', async () => {
  const notGit = 'fatal: not a git repository (or any of the parent directories): .git'
  const plan = planHandoff(repo([failed('Worktree root', notGit), failed('Branch', notGit)]), '/work/plain/')
  expect(plan?.path).toBe('/work/plain/.claude/handoffs/2026-10-12-154500-no-branch.md')
})

test('planHandoff gives null when the timestamp failed or is malformed', async () => {
  expect(planHandoff(repo([failed('Timestamp', 'date: not found')]), '/w')).toBe(null)
  expect(planHandoff(repo([ok('Timestamp', 'Mon Oct 12')]), '/w')).toBe(null)
  expect(planHandoff(repo().filter((s) => s.label !== 'Timestamp'), '/w')).toBe(null)
})

test('the prompt holds every step\'s label and output, and marks failures', async () => {
  const { prompt } = planHandoff(repo([failed('Stashes', 'fatal: bad stash')]), '/w') ?? { prompt: '' }
  for (const step of REPO_STEPS) expect(prompt).toContain(`### ${step.label}`)
  expect(prompt).toContain('feat/Handoff X')
  expect(prompt).toContain('(failed) fatal: bad stash')
  expect(prompt).toContain('# Handoff: <the task, in at most 6 words>')
  expect(prompt).toContain('You have no tools in this reply.')
})

test('an empty successful output shows as (none)', async () => {
  const { prompt } = planHandoff(repo(), '/w') ?? { prompt: '' }
  expect(prompt).toContain('### Stashes\n(none)')
})

test('handoffDocument drops a preamble before the first # Handoff: line', async () => {
  expect(handoffDocument('Here is the handoff. # Handoff: demo\n\nbody')).toBe('# Handoff: demo\n\nbody\n')
  expect(handoffDocument('  # Handoff: demo\nbody  \n\n')).toBe('# Handoff: demo\nbody\n')
})

test('handoffDocument skips a ## Handoff: sub-heading', async () => {
  expect(handoffDocument('Notes\n## Handoff: sub\n# Handoff: real\nbody')).toBe('# Handoff: real\nbody\n')
})

test('the fork prompt calls a repo not a git repo only when the Worktree root step failed', async () => {
  const { prompt } = planHandoff(repo(), '/w') ?? { prompt: '' }
  expect(prompt).toContain(
    'If the Worktree root step failed, this is not a git repo. Leave out the Git state section and describe the changed files from the conversation. Another failed step means only that its output is missing.',
  )
})

test('handoffDocument keeps a reply with no # Handoff: line, and rejects a blank one', async () => {
  expect(handoffDocument('Some document\n')).toBe('Some document\n')
  expect(handoffDocument('  \n')).toBe(null)
})

test('handoffKind falls back to the transcript handoff once the cache has expired', async () => {
  expect(handoffKind('document', 1000, 999)).toBe('document')
  expect(handoffKind('document', 1000, 1000)).toBe('transcript')
  expect(handoffKind('document', 1000, 2000)).toBe('transcript')
  expect(handoffKind('image', 1000, 999)).toBe('image')
  expect(handoffKind('image', 1000, 1000)).toBe('transcript')
})

test('quotePath leaves a plain path alone and single-quotes any other', async () => {
  expect(quotePath('/a/b.jsonl')).toBe('/a/b.jsonl')
  expect(quotePath('/a b/c.jsonl')).toBe("'/a b/c.jsonl'")
  expect(quotePath("/a'b/c.jsonl")).toBe("'/a'\\''b/c.jsonl'")
})

test('resumePrompt and documentResumePrompt quote paths with a space', async () => {
  expect(resumePrompt('/my cfg/p/s.jsonl').startsWith("Read '/my cfg/p/s.jsonl', the transcript")).toBe(true)
  expect(resumePrompt('/p/s.jsonl', '/my cfg/i.md')).toContain("Start with its index, '/my cfg/i.md'.")
  expect(documentResumePrompt('/my repo/.claude/handoffs/x.md')).toBe(
    `Read '/my repo/.claude/handoffs/x.md', check Preconditions, then continue from "Next steps".`,
  )
})

test('endFill uses the reset entry, else the stored one when handoff is on, and only for a clear', () => {
  expect(endFill('clear', 'r', 's', false)).toBe('r')
  expect(endFill('clear', undefined, 's', false)).toBeUndefined()
  expect(endFill('clear', undefined, 's', true)).toBe('s')
  expect(endFill('exit', 'r', 's', true)).toBeUndefined()
})

const TRANSCRIPT = '/home/u/.claude/projects/-work-demo/s1.jsonl'
const IMAGE_INDEX_TEXT = '# Index\n\n## Turn 1 (lines 1-9)\nfix the thing'

test('planImage puts the file under .claude/context-images with the timestamp and slug', async () => {
  const plan = planImage(repo(), '/work/demo/sub', TRANSCRIPT, INDEX, IMAGE_INDEX_TEXT)
  expect(plan?.path).toBe('/work/demo/.claude/context-images/2026-10-12-154500-feat-handoff-x.md')
})

test('planImage falls back to cwd outside git and gives null without a timestamp', async () => {
  const notGit = 'fatal: not a git repository'
  expect(planImage(repo([failed('Worktree root', notGit), failed('Branch', notGit)]), '/work/plain/', undefined, undefined, undefined)?.path).toBe(
    '/work/plain/.claude/context-images/2026-10-12-154500-no-branch.md',
  )
  expect(planImage(repo([failed('Timestamp', 'x')]), '/w', undefined, undefined, undefined)).toBe(null)
})

test('the image prompt asks for the document with the sections and no worker sections', async () => {
  const { prompt } = planImage(repo([failed('Stashes', 'fatal: bad stash')]), '/w', TRANSCRIPT, INDEX, IMAGE_INSTRUCTIONS_PROBE) ?? { prompt: '' }
  expect(prompt).toContain('starting with the line "# Context image: <the task, in at most 6 words>"')
  expect(prompt).toContain('Write no preamble and no code fence around the reply.')
  expect(prompt).toContain('under 4,000 words')
  for (const h of ['Sources', 'Goal and principles', 'Read before starting', 'Decisions', 'Dead ends', 'Orientation', 'Environment', 'Done', 'In progress', 'Next steps', 'Left out', 'Lookup']) {
    expect(prompt).toContain(`## ${h}\n`)
  }
  for (const h of ['Worker protocol', 'Board', 'Updates']) expect(prompt).not.toContain(`## ${h}`)
  expect(prompt).toContain("sed -n 'A,Bp' '<transcript path>' | cut -c1-400")
  expect(prompt).toContain(`grep -n '"uuid":"<uuid>"' '<transcript path>'`)
  expect(prompt).toContain('(failed) fatal: bad stash')
  for (const step of REPO_STEPS) expect(prompt).toContain(`### ${step.label}`)
})

const IMAGE_INSTRUCTIONS_PROBE = IMAGE_INDEX_TEXT

test('the image prompt ends with the paths and the index text, or says there is none', async () => {
  const withIndex = planImage(repo(), '/w', TRANSCRIPT, INDEX, IMAGE_INDEX_TEXT)?.prompt ?? ''
  expect(withIndex).toContain(`Transcript path: ${TRANSCRIPT}`)
  expect(withIndex).toContain(`Transcript index path: ${INDEX}`)
  expect(withIndex.endsWith(IMAGE_INDEX_TEXT)).toBe(true)
  const none = planImage(repo(), '/w', undefined, undefined, undefined)?.prompt ?? ''
  expect(none).toContain('Transcript path: (not found)')
  expect(none).toContain('Transcript index path: (no index exists)')
  expect(none).toContain('No transcript index exists for this session.')
})

test('imageDocument drops a preamble before the first # Context image: line', async () => {
  expect(imageDocument('Here it is. # Context image: demo\n\nbody')).toBe('# Context image: demo\n\nbody\n')
  expect(imageDocument('Notes\n## Context image: sub\n# Context image: real\nbody')).toBe('# Context image: real\nbody\n')
  expect(imageDocument('Some document\n')).toBe('Some document\n')
  expect(imageDocument('  \n')).toBe(null)
})

test('imageResumePrompt names the file and the sections, and quotes a path with a space', async () => {
  expect(imageResumePrompt('/work/demo/.claude/context-images/x.md')).toBe(
    'Read /work/demo/.claude/context-images/x.md in full, then every file it lists under "Read before starting". Continue from "Next steps".',
  )
  expect(imageResumePrompt('/my repo/x.md').startsWith("Read '/my repo/x.md' in full")).toBe(true)
})
