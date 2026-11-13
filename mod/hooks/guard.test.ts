import { test, expect } from 'claude-code/testing'
import { claimedWorktree, guardReason, outsideWrite } from './guard'

const CLAIM_TEXT = 'CLAIMED 0001-t1-a1.json\nYour worktree is /code/app.t1; run every command there and touch no other checkout.\nTask 1 of /p.md, "x".'

test('claimedWorktree reads the worktree from an orch-claim result', async () => {
  expect(claimedWorktree('/c/bin/orch-claim /r/x.run work', CLAIM_TEXT)).toBe('/code/app.t1')
  expect(claimedWorktree("/c/bin/orch-claim '/r/x.run' review", CLAIM_TEXT)).toBe('/code/app.t1')
})

test('claimedWorktree ignores other commands and results without a claim', async () => {
  expect(claimedWorktree('cat notes.md', CLAIM_TEXT)).toBe(null)
  expect(claimedWorktree('orch-claim /r/x.run --status', CLAIM_TEXT)).toBe(null)
  expect(claimedWorktree('/c/bin/orch-claim /r/x.run work', 'NO TASK: the work queue is empty. Report that and stop.')).toBe(null)
})

test('outsideWrite allows paths inside the worktree', async () => {
  expect(outsideWrite('Edit', { file_path: '/code/app.t1/lib/a.js' }, '/code/app.t1')).toBe(null)
})

test('outsideWrite returns a path outside the worktree', async () => {
  expect(outsideWrite('Write', { file_path: '/code/app/lib/a.js' }, '/code/app.t1')).toBe('/code/app/lib/a.js')
})

test('outsideWrite refuses a sibling whose name starts with the worktree path', async () => {
  expect(outsideWrite('Write', { file_path: '/code/app.t10/x' }, '/code/app.t1')).toBe('/code/app.t10/x')
})

test('outsideWrite refuses a path with a .. segment', async () => {
  const p = '/code/app.t1/../app/lib/a.js'
  expect(outsideWrite('Edit', { file_path: p }, '/code/app.t1')).toBe(p)
})

test('outsideWrite allows the scratchpad under a temp root', async () => {
  expect(outsideWrite('Write', { file_path: '/private/tmp/claude-502/p/s/scratchpad/x.md' }, '/code/app.t1')).toBe(null)
})

test('outsideWrite reads notebook_path for NotebookEdit', async () => {
  expect(outsideWrite('NotebookEdit', { notebook_path: '/code/app/n.ipynb' }, '/code/app.t1')).toBe('/code/app/n.ipynb')
})

test('outsideWrite ignores other tools and a missing path', async () => {
  expect(outsideWrite('Bash', { command: 'echo > /code/app/x' }, '/code/app.t1')).toBe(null)
  expect(outsideWrite('Edit', {}, '/code/app.t1')).toBe(null)
})

test('guardReason names both paths and the scratchpad', async () => {
  const text = guardReason('/code/app/lib/a.js', '/code/app.t1')
  expect(text).toContain('/code/app/lib/a.js')
  expect(text).toContain('/code/app.t1')
  expect(text).toContain('scratchpad')
  expect(text.startsWith('This worker claimed the worktree')).toBe(true)
})
