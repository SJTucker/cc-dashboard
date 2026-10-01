import type { On, SessionRateLimit, UsageUnit } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

type Ran = { argv: readonly string[]; stdin: unknown; timeoutMs: number | undefined }
type World = { id: string; model: string; env: Record<string, string> }

const FIVE: SessionRateLimit = { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-01T15:00:00.000Z' }
const WEEK: SessionRateLimit = { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-05T09:30:00.000Z' }

// Answers every noun the mod calls, beneath it. `w` is read on each call, so a
// test can change the session id, the model or the environment between events.
// Returns what process.run got.
function world(on: On, w: Partial<World> = {}, exitCode = 0, runThrows = false) {
  const state: World = { id: 's1', model: 'claude-opus-5-5[1m]', env: { HOME: '/home/u' }, ...w }
  const ran: Ran[] = []
  mock.clock(on, { now: 61_000 })
  on('fs.stat', () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: '/repo/mod' } }))
  on('env.get', (_$, e) => ({ value: state.env[e.name] }))
  on('session.id', () => ({ value: state.id }))
  on('session.root', () => ({ value: '/work/my.demo' }))
  on('session.model', () => ({ value: state.model }))
  on('session.usage', () => ({ value: { startedAt: 1_000, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('process.run', (_$, e) => {
    if (runThrows) throw new Error('spawn failed')
    ran.push({
      argv: e.argv,
      stdin: e.init?.stdin === undefined ? undefined : JSON.parse(e.init.stdin),
      timeoutMs: e.init?.timeoutMs,
    })
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, state }
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

