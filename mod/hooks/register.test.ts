import type { On, SessionRateLimit, UsageUnit } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

type Ran = { argv: readonly string[]; stdin: unknown; timeoutMs: number | undefined }
type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }
// `exists` answers fs.exists. `dirs` maps a folder to the names fs.list returns for it.
type World = {
  id: string
  model: string
  env: Record<string, string>
  exists: (path: string) => boolean
  dirs: Record<string, string[]>
}

const entry = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const FIVE: SessionRateLimit = { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-01T15:00:00.000Z' }
const WEEK: SessionRateLimit = { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-05T09:30:00.000Z' }

// Answers every noun the mod calls, beneath it. `w` is read on each call, so a
// test can change the session id, the model or the environment between events.
// Returns what process.run got and the folders fs.list was asked for.
function world(on: On, w: Partial<World> = {}, exitCode = 0, runThrows = false) {
  const state: World = {
    id: 's1',
    model: 'claude-opus-5-5[1m]',
    env: { HOME: '/home/u' },
    exists: () => true,
    dirs: {},
    ...w,
  }
  const ran: Ran[] = []
  const endSawRan: number[] = []
  const listed: string[] = []
  mock.clock(on, { now: 61_000 })
  on('fs.stat', () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: '/repo/mod' } }))
  on('fs.exists', (_$, e) => ({ value: state.exists(e.path) }))
  on('fs.list', (_$, e) => {
    listed.push(e.path)
    return { value: (state.dirs[e.path] ?? []).map(entry) }
  })
  on('env.get', (_$, e) => ({ value: state.env[e.name] }))
  on('session.id', () => ({ value: state.id }))
  on('session.root', () => ({ value: '/work/my.demo' }))
  on('session.model', () => ({ value: state.model }))
  on('session.usage', () => ({ value: { startedAt: 1_000, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', async (_$, e) => {
    // Gives a script that has started a few ticks to reach process.run first.
    for (let tick = 0; tick < 500; tick++) await Promise.resolve()
    endSawRan.push(ran.length)
    return { sessionId: e.sessionId }
  })
  on('process.run', (_$, e) => {
    if (runThrows) throw new Error('spawn failed')
    ran.push({
      argv: e.argv,
      stdin: e.init?.stdin === undefined ? undefined : JSON.parse(e.init.stdin),
      timeoutMs: e.init?.timeoutMs,
    })
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, state, listed, endSawRan }
}

const measure = (rateLimits: SessionRateLimit[], cost: { usd: number } | null = { usd: 0.42 }) => ({
  context: { window: 200_000 },
  rateLimits,
  ...(cost ? { cost } : {}),
  changed: ['cost', 'rateLimits'] satisfies UsageUnit[],
})

test('a measure pipes statusline JSON to record-statusline', async ($, on) => {
  const { ran } = world(on)
  await $.session.measure(measure([FIVE, WEEK]))
  expect(ran).toEqual([{
    argv: ['/repo/bin/record-statusline'],
    timeoutMs: 5000,
    stdin: {
      session_id: 's1',
      transcript_path: '/home/u/.claude/projects/-work-my-demo/s1.jsonl',
      workspace: { project_dir: '/work/my.demo' },
      model: { display_name: 'Opus 5.5 (1M context)' },
      cost: { total_cost_usd: 0.42, total_duration_ms: 60_000 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1790866800 },
        seven_day: { used_percentage: 41, resets_at: 1791192600 },
      },
    },
  }])
})

test('a measure with no rate limits leaves rate_limits out', async ($, on) => {
  const { ran } = world(on)
  await $.session.measure(measure([]))
  expect(ran.length).toBe(1)
  expect(ran[0]?.stdin).not.toHaveProperty('rate_limits')
})

test('a measure with neither cost nor rate limits runs nothing', async ($, on) => {
  const { ran } = world(on)
  await $.session.measure(measure([], null))
  expect(ran).toEqual([])
})

test('CLAUDE_CONFIG_DIR replaces ~/.claude in the transcript path', async ($, on) => {
  const { ran } = world(on, { env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' } })
  await $.session.measure(measure([FIVE]))
  expect((ran[0]?.stdin as { transcript_path: string }).transcript_path).toBe('/cfg/projects/-work-my-demo/s1.jsonl')
})

test('a transcript outside the built path is found by searching the projects folder', async ($, on) => {
  const found = '/home/u/.claude/projects/-work-start-dir/s1.jsonl'
  const { ran, listed } = world(on, {
    exists: (path) => path === found,
    dirs: { '/home/u/.claude/projects': ['-work-my-demo', '-work-start-dir'] },
  })
  await $.session.measure(measure([FIVE]))
  expect(listed).toEqual(['/home/u/.claude/projects'])
  expect(ran.length).toBe(1)
  const input = ran[0]?.stdin as { transcript_path: string; workspace: { project_dir: string } }
  expect(input.transcript_path).toBe(found)
  expect(input.workspace.project_dir).toBe('/work/my.demo')
})

test('a transcript that exists nowhere records nothing and logs once', async ($, on) => {
  const { ran } = world(on, { exists: () => false, dirs: { '/home/u/.claude/projects': ['-work-my-demo'] } })
  const logged: string[] = []
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(ran).toEqual([])
  expect(logged).toEqual(['cc-dashboard: transcript not found'])
})

test('a CLAUDE_CONFIG_DIR that starts with ~ expands with HOME', async ($, on) => {
  const { ran } = world(on, { env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '~/cfg' } })
  await $.session.measure(measure([FIVE]))
  expect((ran[0]?.stdin as { transcript_path: string }).transcript_path).toBe('/home/u/cfg/projects/-work-my-demo/s1.jsonl')
})

test('a second measure for the same session does not search again', async ($, on) => {
  const found = '/home/u/.claude/projects/-work-start-dir/s1.jsonl'
  const { ran, listed } = world(on, {
    exists: (path) => path === found,
    dirs: { '/home/u/.claude/projects': ['-work-start-dir'] },
  })
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(ran.length).toBe(2)
  expect(listed.length).toBe(1)
})

test('with neither HOME nor CLAUDE_CONFIG_DIR a measure runs nothing', async ($, on) => {
  const { ran } = world(on, { env: {} })
  await $.session.measure(measure([FIVE]))
  expect(ran).toEqual([])
})

test('after a /clear the next measure records under the new session id', async ($, on) => {
  const { ran, state } = world(on)
  await $.session.measure(measure([FIVE]))
  state.id = 's2'
  await $.session.measure(measure([FIVE]))
  expect(ran.map((r) => (r.stdin as { session_id: string; transcript_path: string }).transcript_path)).toEqual([
    '/home/u/.claude/projects/-work-my-demo/s1.jsonl',
    '/home/u/.claude/projects/-work-my-demo/s2.jsonl',
  ])
})

test('model ids become the names the statusline shows', async ($, on) => {
  const { ran, state } = world(on)
  const ids = ['claude-opus-5-5[1m]', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'opus']
  for (const id of ids) {
    state.model = id
    await $.session.measure(measure([FIVE]))
  }
  expect(ran.map((r) => (r.stdin as { model: { display_name: string } }).model.display_name)).toEqual([
    'Opus 5.5 (1M context)', 'Opus 5', 'Haiku 4.5', 'Fable 5.1', 'opus',
  ])
})

test('a process.run that throws does not reject the measure or change its result', async ($, on) => {
  const { ran } = world(on, {}, 0, true)
  const result = await $.session.measure(measure([FIVE]))
  expect(result).toEqual({ changed: ['cost', 'rateLimits'] })
  expect(ran).toEqual([])
})

test('a measure with rate limits and no cost sends rate_limits and leaves cost out', async ($, on) => {
  const { ran } = world(on)
  await $.session.measure(measure([FIVE], null))
  expect(ran.length).toBe(1)
  expect(ran[0]?.stdin).not.toHaveProperty('cost')
  expect(ran[0]?.stdin).toHaveProperty('rate_limits.five_hour.used_percentage', 23.5)
})

test('a rate limit of another kind is left out of rate_limits', async ($, on) => {
  const { ran } = world(on)
  const spend: SessionRateLimit = { kind: 'spend_limit', percentUsed: 5, resetsAt: '2026-10-01T15:00:00.000Z' }
  await $.session.measure(measure([FIVE, spend]))
  await $.session.measure(measure([spend]))
  const limits = ran.map((r) => (r.stdin as { rate_limits?: object }).rate_limits)
  expect(limits[0]).toEqual({ five_hour: { used_percentage: 23.5, resets_at: 1790866800 } })
  expect(limits[1]).toBeUndefined()
  expect(ran[1]?.stdin).not.toHaveProperty('rate_limits')
})

test('a window with no resetsAt is sent without resets_at', async ($, on) => {
  const { ran } = world(on)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 12 }]))
  expect((ran[0]?.stdin as { rate_limits: object }).rate_limits).toEqual({ five_hour: { used_percentage: 12 } })
})

test('session.end pipes session_id and reason to record-session-end', async ($, on) => {
  const { ran } = world(on)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(ran).toEqual([{ argv: ['/repo/bin/record-session-end'], timeoutMs: 1200, stdin: { session_id: 's1', reason: 'clear' } }])
})

test('a failing session end still passes the event on', async ($, on) => {
  const { ran } = world(on, {}, 1)
  const result = await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(result).toEqual({ sessionId: 's1' })
  expect(ran.length).toBe(1)
})

test('session.end starts the script before the event passes on', async ($, on) => {
  const { endSawRan } = world(on)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(endSawRan).toEqual([1])
})

test('a failing run logs once, and a second failure logs nothing', async ($, on) => {
  const { ran } = world(on, {}, 1)
  const logged: string[] = []
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(ran.length).toBe(2)
  expect(logged).toEqual(['cc-dashboard: record-statusline failed (exit 1)'])
})
