import { test, expect } from 'claude-code/testing'
import { DETAIL_MAX, newestTool, setState, toolDetail } from './activity'
import type { Activity, ToolRun } from './activity'

const run = (name: string): ToolRun => ({ name, detail: '', startedAt: 1 })
const activity = (state: Activity['state'], since: number): Activity => ({
  sessionId: 's', state, since, tool: null, subagents: 0, updatedAt: since,
})

test('newestTool is the last started tool, or null with none', async () => {
  const tools = new Map<string, ToolRun>([['a', run('Read')], ['b', run('Bash')]])
  expect(newestTool(tools)?.name).toBe('Bash')
  expect(newestTool(new Map())).toBeNull()
})

test('setState changes the state and its time, and leaves an unchanged state alone', async () => {
  const a = activity('working', 100)
  setState(a, 'working', 200)
  expect(a).toMatchObject({ state: 'working', since: 100 })
  setState(a, 'waiting', 300)
  expect(a).toMatchObject({ state: 'waiting', since: 300 })
})

test('toolDetail cuts a Bash command to one line of DETAIL_MAX characters', async () => {
  expect(toolDetail('Bash', { command: '  ls   -la\n\tfoo ' })).toBe('ls -la foo')
  expect(toolDetail('Bash', { command: 'x'.repeat(100) }).length).toBe(DETAIL_MAX)
  expect(toolDetail('Bash', {})).toBe('')
})

test('toolDetail gives the file name for Read, Edit and Write and nothing for other tools', async () => {
  expect(toolDetail('Read', { file_path: '/a/b/c.ts' })).toBe('c.ts')
  expect(toolDetail('Edit', { file_path: 'C:\\a\\d.ts' })).toBe('d.ts')
  expect(toolDetail('Write', { file_path: 5 })).toBe('')
  expect(toolDetail('Grep', { pattern: 'x' })).toBe('')
})
