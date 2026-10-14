import { test, expect } from 'claude-code/testing'
import { REPO_STEPS, branchSlug, handoffDocument, handoffWaitMs, hourCacheExpiry, planHandoff, resumePrompt } from './handoff'
import type { StepOutput } from './handoff'

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

test('resumePrompt names the file and the two sections to read', async () => {
  expect(resumePrompt('/work/demo/.claude/handoffs/2026-10-12-154500-main.md')).toBe(
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
  expect(prompt).toContain('# Handoff: <task in one line>')
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

test('hourCacheExpiry gives the expiry of a 1h cache and null for anything else', async () => {
  expect(hourCacheExpiry({ ttl: '1h', expiresAt: 5000 })).toBe(5000)
  expect(hourCacheExpiry({ ttl: '5m', expiresAt: 5000 })).toBeNull()
  expect(hourCacheExpiry({ ttl: '1h', expiresAt: '5000' })).toBeNull()
  expect(hourCacheExpiry({})).toBeNull()
})

test('handoffWaitMs is the time to leadMs before expiry, and null once that has passed', async () => {
  expect(handoffWaitMs(10_000, 1000, 6000)).toBe(3000)
  expect(handoffWaitMs(10_000, 4000, 6000)).toBeNull()
  expect(handoffWaitMs(10_000, 5000, 6000)).toBeNull()
})
