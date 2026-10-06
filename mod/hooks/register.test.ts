import type { AgentInfo, On, SessionRateLimit, UsageUnit } from 'claude-code'
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
  files: Record<string, string>
  version: { version: string; base?: string }
  fetch: () => { status: number; ok: boolean; text: string }
  registerFails: boolean
  // `throws` makes model.complete reject, as an engine refusal does.
  replies: Array<
    | { isAnswered: true; text: string }
    | { isAnswered: false; reason: 'api-error'; status: number | null; error: 'unknown' }
    | { isAnswered: false; reason: 'empty-reply' | 'aborted' }
    | { throws: true }
  >
  scripts: Record<string, { exitCode: number; stdout: string; stderr?: string }>
  // Answers bin/review-session by subcommand. Its runs go to reviewRan, so the
  // update tests' exact run lists in `ran` stay as they are.
  reviews: Record<string, { exitCode: number; stdout: string; stderr?: string }>
  // The plugin's key-value store, which $.store.get and $.store.set read and write.
  store: Record<string, unknown>
  // The session's agents, which $.agent.list returns.
  agents: AgentInfo[]
  // How long a tool.call lasts on the mock clock, and what tool.check answers.
  toolMs: number
  verdict: 'allow' | 'ask' | 'deny'
  // Makes tool.call throw once its toolMs has passed.
  toolFails: boolean
  // Makes fs.write reject.
  writeFails: boolean
  // How long each fs.write takes on the mock clock, in call order. A write past the
  // end of the list takes no time.
  writeMs: number[]
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
    files: {},
    version: { version: '2.1.290', base: '2.1.290' },
    fetch: () => ({ status: 200, ok: true, text: '## 2.1.290\n- Compaction keeps fewer tool results' }),
    replies: [],
    registerFails: false,
    scripts: {},
    reviews: { prompt: { exitCode: 0, stdout: '{"reviews":[]}' } },
    store: {},
    agents: [],
    toolMs: 0,
    verdict: 'allow',
    toolFails: false,
    writeFails: false,
    writeMs: [],
    ...w,
  }
  const ran: Ran[] = []
  const reviewRan: Ran[] = []
  const endSawRan: number[] = []
  const listed: string[] = []
  const clock = mock.clock(on, { now: 61_000 })
  on('fs.stat', () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: '/repo/mod' } }))
  on('fs.exists', (_$, e) => ({ value: state.exists(e.path) }))
  on('fs.list', (_$, e) => {
    listed.push(e.path)
    return { value: (state.dirs[e.path] ?? []).map(entry) }
  })
  on('env.get', (_$, e) => ({ value: state.env[e.name] }))
  const fetched: string[] = []
  const asked: Array<{ model: string; system?: string; prompt: string; maxTokens?: number; effort?: string; timeoutMs?: number }> = []
  const registered: string[] = []
  const logged: string[] = []
  on('fs.read', (_$, e) => {
    const text = state.files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)
    return { value: { headers: {}, ...state.fetch() } }
  })
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', (_$, e) => {
    asked.push(e)
    const reply = state.replies.shift() ?? { isAnswered: false as const, reason: 'empty-reply' as const }
    if ('throws' in reply) throw new Error('refused')
    return { value: { ...reply, usage } }
  })
  on('store.get', (_$, e) => ({ value: state.store[e.key] }))
  on('store.set', (_$, e) => {
    state.store[e.key] = e.value
    return { value: undefined }
  })
  on('session.version', () => ({ value: state.version }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    if (state.registerFails) throw new Error('refused')
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
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
    if (e.argv[0]?.endsWith('/review-session')) {
      const stdin = e.init?.stdin
      let parsed: unknown = stdin
      try {
        parsed = stdin ? JSON.parse(stdin) : stdin
      } catch {
        // left as text
      }
      reviewRan.push({ argv: e.argv, stdin: parsed, timeoutMs: e.init?.timeoutMs })
      const out = state.reviews[e.argv[1] ?? ''] ?? { exitCode: 1, stdout: '', stderr: 'review-session: no answer set' }
      return { value: { stderr: '', ...out, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (runThrows) throw new Error('spawn failed')
    const stdin = e.init?.stdin
    let parsed: unknown = stdin
    try {
      parsed = stdin === undefined ? undefined : JSON.parse(stdin)
    } catch {
      // the changelog is plain text
    }
    ran.push({ argv: e.argv, stdin: parsed, timeoutMs: e.init?.timeoutMs })
    const script = e.argv[0]?.endsWith('/judge-updates') ? state.scripts[e.argv[1] ?? ''] : undefined
    const out = script ?? { exitCode, stdout: '', stderr: '' }
    return { value: { stderr: '', ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const writes: Record<string, string> = {}
  const writeLog: Array<{ path: string; text: string }> = []
  on('fs.write', async (_$, e) => {
    if (state.writeFails) throw new Error('disk full')
    const ms = state.writeMs.shift() ?? 0
    if (ms > 0) await clock.sleep(ms)
    writes[e.path] = e.text
    writeLog.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('agent.list', () => ({ value: state.agents }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', async () => {
    if (state.toolMs > 0) await clock.sleep(state.toolMs)
    if (state.toolFails) throw new Error('tool failed')
    return { result: 'ok', text: 'ok' }
  })
  on('tool.check', () => ({ decision: state.verdict }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'a1' }))
  return { ran, reviewRan, state, listed, endSawRan, clock, fetched, asked, registered, logged, writes, writeLog }
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

test('a transcript that exists nowhere records nothing and, with a cost, logs once', async ($, on) => {
  const { ran, logged } = world(on, { exists: () => false, dirs: { '/home/u/.claude/projects': ['-work-my-demo'] } })
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(ran).toEqual([])
  expect(logged).toEqual(['transcript not found'])
})

test('a measure without cost on a missing transcript logs nothing, and a later one with cost still logs', async ($, on) => {
  const { ran, logged } = world(on, { exists: () => false, dirs: { '/home/u/.claude/projects': ['-work-my-demo'] } })
  await $.session.measure(measure([FIVE], null))
  expect(ran).toEqual([])
  expect(logged).toEqual([])
  await $.session.measure(measure([FIVE]))
  expect(logged).toEqual(['transcript not found'])
})

test('a measure without cost records once the transcript appears', async ($, on) => {
  let written = false
  const { ran } = world(on, { exists: () => written })
  await $.session.measure(measure([FIVE], null))
  written = true
  await $.session.measure(measure([FIVE], null))
  expect(ran.length).toBe(1)
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
  const { ran, logged } = world(on, {}, 1)
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(ran.length).toBe(2)
  expect(logged).toEqual(['record-statusline failed (exit 1)'])
})

const UPDATES = '/home/u/.claude/cc-dashboard/updates.json'
const start = { cwd: '/work/my.demo', surface: null, isInteractive: true }
const backfill = { command: 'backfill-updates', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const BATCH = { versions: ['2.1.290'], system: 'SYSTEM', prompt: '## 2.1.290\n- Compaction keeps fewer tool results' }
const VERDICT = '[{"version":"2.1.290","relevant":true,"summary":"Compaction keeps fewer tool results"}]'
const judging = {
  prompt: { exitCode: 0, stdout: JSON.stringify({ batches: [BATCH] }) },
  record: { exitCode: 0, stdout: '{"recorded":1,"relevant":1,"unjudged":0}' },
}

test('session.start registers /backfill-updates', async ($, on) => {
  const { registered } = world(on, { files: { [UPDATES]: '{"2.1.290":{"relevant":false}}' } })
  await $.session.start(start)
  expect(registered).toEqual(['backfill-updates'])
})

test('session.start returns before the check fetches', async ($, on) => {
  const { fetched, clock } = world(on, { scripts: judging, replies: [{ isAnswered: true, text: VERDICT }] })
  await $.session.start(start)
  expect(fetched).toEqual([])
  await clock.settle()
  expect(fetched.length).toBe(1)
})

test('a version that has a verdict makes no request', async ($, on) => {
  const { fetched, asked, clock } = world(on, { files: { [UPDATES]: '{"2.1.290":{"relevant":false}}' } })
  await $.session.start(start)
  await clock.settle()
  expect(fetched).toEqual([])
  expect(asked).toEqual([])
})

test('a version with no verdict is fetched, judged by Haiku and recorded', async ($, on) => {
  const { ran, fetched, asked, clock } = world(on, { scripts: judging, replies: [{ isAnswered: true, text: VERDICT }] })
  await $.session.start(start)
  await clock.settle()
  expect(fetched).toEqual(['https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'])
  expect(ran.map((r) => r.argv)).toEqual([
    ['/repo/bin/judge-updates', 'prompt', '--current', '2.1.290'],
    ['/repo/bin/judge-updates', 'record'],
  ])
  expect(ran[0]?.stdin).toBe('## 2.1.290\n- Compaction keeps fewer tool results')
  expect(asked).toEqual([{ model: 'haiku', system: 'SYSTEM', prompt: BATCH.prompt, maxTokens: 2048, effort: 'low', timeoutMs: 60000 }])
  expect(ran[1]?.stdin).toEqual({ versions: ['2.1.290'], reply: VERDICT })
})

test('a failed fetch logs and asks Haiku nothing', async ($, on) => {
  const { asked, logged, clock } = world(on, { fetch: () => ({ status: 503, ok: false, text: '' }) })
  await $.session.start(start)
  await clock.settle()
  expect(asked).toEqual([])
  expect(logged).toEqual(['changelog fetch returned 503'])
})

test('a Haiku call with no answer records nothing and logs the reason', async ($, on) => {
  const { ran, logged, clock } = world(on, { scripts: judging, replies: [{ isAnswered: false, reason: 'api-error', status: null, error: 'unknown' }] })
  await $.session.start(start)
  await clock.settle()
  expect(ran.map((r) => r.argv[1])).toEqual(['prompt'])
  expect(logged).toEqual(['Haiku gave no verdict for 2.1.290 (api-error)'])
})

test('UPDATES_FILE overrides the verdict file the check reads', async ($, on) => {
  const { fetched, asked, clock } = world(on, {
    env: { HOME: '/home/u', UPDATES_FILE: '~/elsewhere/updates.json' },
    files: { '/home/u/elsewhere/updates.json': '{"2.1.290":{"relevant":false}}' },
  })
  await $.session.start(start)
  await clock.settle()
  expect(fetched).toEqual([])
  expect(asked).toEqual([])
})

test('a fetch that throws logs the error name and asks Haiku nothing', async ($, on) => {
  const { asked, logged, clock } = world(on, { fetch: () => { throw new Error('offline') } })
  await $.session.start(start)
  await clock.settle()
  expect(asked).toEqual([])
  expect(logged).toEqual(['changelog fetch failed (HooksError)'])
})

test('a dev build is not checked', async ($, on) => {
  const { fetched, clock } = world(on, { version: { version: '2.1.290-dev.20261001.t1.sha1', base: '2.1.290-dev' } })
  await $.session.start(start)
  await clock.settle()
  expect(fetched).toEqual([])
})

test('a malformed updates.json logs and fetches nothing', async ($, on) => {
  const { fetched, logged, clock } = world(on, { files: { [UPDATES]: '{"2.1.290": tru' } })
  await $.session.start(start)
  await clock.settle()
  expect(fetched).toEqual([])
  expect(logged).toEqual([`${UPDATES} is not valid JSON; fix or delete it`])
})

for (const [name, content] of [['an array', '[]'], ['null', 'null']] as const) {
  test(`an updates.json holding ${name} logs and fetches nothing`, async ($, on) => {
    const { fetched, asked, logged, clock } = world(on, { files: { [UPDATES]: content } })
    await $.session.start(start)
    await clock.settle()
    expect(fetched).toEqual([])
    expect(asked).toEqual([])
    expect(logged).toEqual([`${UPDATES} is not a JSON object; fix or delete it`])
  })
}

const HOUR = 60 * 60 * 1000

test('a second session start within the hour does not fetch again', async ($, on) => {
  const { fetched, clock } = world(on)
  await $.session.start(start)
  await clock.settle()
  await $.session.start(start)
  await clock.settle()
  expect(fetched.length).toBe(1)
})

test('a session start an hour later fetches again', async ($, on) => {
  const { fetched, clock } = world(on)
  await $.session.start(start)
  await clock.settle()
  await clock.advance(HOUR)
  await $.session.start(start)
  await clock.settle()
  expect(fetched.length).toBe(2)
})

test('a different running version is not held back by the last check', async ($, on) => {
  const { fetched, clock, state } = world(on)
  await $.session.start(start)
  await clock.settle()
  state.version = { version: '2.1.291', base: '2.1.291' }
  await $.session.start(start)
  await clock.settle()
  expect(fetched.length).toBe(2)
})

test('/backfill-updates fetches inside the hour', async ($, on) => {
  const { fetched, clock } = world(on)
  await $.session.start(start)
  await clock.settle()
  await $.command.run(backfill)
  expect(fetched.length).toBe(2)
})

test('/backfill-updates judges every batch and reports the counts', async ($, on) => {
  const second = { versions: ['2.1.291'], system: 'SYSTEM', prompt: '## 2.1.291\n- x' }
  const { ran, asked } = world(on, {
    scripts: { ...judging, prompt: { exitCode: 0, stdout: JSON.stringify({ batches: [BATCH, second] }) } },
    replies: [{ isAnswered: true, text: VERDICT }, { isAnswered: true, text: '[]' }],
  })
  const result = await $.command.run(backfill)
  expect(ran[0]?.argv).toEqual(['/repo/bin/judge-updates', 'prompt'])
  expect(asked.length).toBe(2)
  expect(result.text).toBe('Judged 2 of 2 versions, 2 relevant.')
})

test('/backfill-updates with nothing pending says so', async ($, on) => {
  const { asked } = world(on, { scripts: { prompt: { exitCode: 0, stdout: '{"batches":[]}' } } })
  const result = await $.command.run(backfill)
  expect(asked).toEqual([])
  expect(result.text).toBe('No Claude Code version needs a verdict.')
})

test('/backfill-updates names a failing script', async ($, on) => {
  const { asked } = world(on, { scripts: { prompt: { exitCode: 1, stdout: '', stderr: 'judge-updates: boom\n' } } })
  const result = await $.command.run(backfill)
  expect(asked).toEqual([])
  expect(result.text).toBe('Judged 0 of 0 versions, 0 relevant. Failed: judge-updates prompt failed (exit 1): judge-updates: boom')
})

test('a failing command.register is logged and session.start still resolves', async ($, on) => {
  const { logged } = world(on, { registerFails: true, files: { [UPDATES]: '{"2.1.290":{"relevant":false}}' } })
  await $.session.start(start)
  expect(logged).toEqual(['could not register /backfill-updates (HooksError)'])
})

test('/backfill-updates names a prompt that printed no batches', async ($, on) => {
  const { asked } = world(on, { scripts: { prompt: { exitCode: 0, stdout: '{}' } } })
  const result = await $.command.run(backfill)
  expect(asked).toEqual([])
  expect(result.text).toBe('Judged 0 of 0 versions, 0 relevant. Failed: judge-updates prompt printed no batches')
})

test('/backfill-updates carries on after one Haiku call rejects', async ($, on) => {
  const second = { versions: ['2.1.291'], system: 'SYSTEM', prompt: '## 2.1.291\n- x' }
  const { ran } = world(on, {
    scripts: { ...judging, prompt: { exitCode: 0, stdout: JSON.stringify({ batches: [BATCH, second] }) } },
    replies: [{ throws: true }, { isAnswered: true, text: VERDICT }],
  })
  const result = await $.command.run(backfill)
  expect(ran.filter((r) => r.argv[1] === 'record').length).toBe(1)
  expect(result.text).toBe('Judged 1 of 2 versions, 1 relevant. Failed: Haiku call failed for 2.1.290 (HooksError)')
})

// updates.json already has a verdict for the running version, so these tests make
// no update request and `asked` holds only review calls.
const judged = { [UPDATES]: '{"2.1.290":{"relevant":false}}' }
const REVIEW = { sessionId: 'old', system: 'REVIEW SYSTEM', prompt: 'USER: fix it' }
type Answer = { exitCode: number; stdout: string; stderr?: string }
const reviewing = (reviews = [REVIEW], record: Answer = { exitCode: 0, stdout: '{"status":"done","suggestions":0}' }) => ({
  prompt: { exitCode: 0, stdout: JSON.stringify({ reviews }) },
  record,
})

test('session.start reviews ended sessions after it returns', async ($, on) => {
  const { reviewRan, asked, clock } = world(on, {
    files: judged,
    reviews: reviewing(),
    replies: [{ isAnswered: true, text: '{"suggestions":[]}' }],
  })
  await $.session.start(start)
  expect(reviewRan).toEqual([])
  await clock.settle()
  expect(reviewRan.map((r) => r.argv)).toEqual([
    ['/repo/bin/review-session', 'prompt'],
    ['/repo/bin/review-session', 'record'],
  ])
  expect(reviewRan[0]?.timeoutMs).toBe(60000)
  expect(asked).toEqual([{ model: 'haiku', system: 'REVIEW SYSTEM', prompt: 'USER: fix it', maxTokens: 1024, effort: 'low', timeoutMs: 60000 }])
  expect(reviewRan[1]?.stdin).toEqual({ sessionId: 'old', reply: '{"suggestions":[]}' })
})

test('no ended session means no Haiku call', async ($, on) => {
  const { reviewRan, asked, logged, clock } = world(on, { files: judged })
  await $.session.start(start)
  await clock.settle()
  expect(reviewRan.map((r) => r.argv[1])).toEqual(['prompt'])
  expect(asked).toEqual([])
  expect(logged).toEqual([])
})

test('a Haiku call with no answer is recorded as an error', async ($, on) => {
  const { reviewRan, clock } = world(on, {
    files: judged,
    reviews: reviewing(),
    replies: [{ isAnswered: false, reason: 'empty-reply' }],
  })
  await $.session.start(start)
  await clock.settle()
  expect(reviewRan[1]?.stdin).toEqual({ sessionId: 'old', error: 'Haiku gave no answer (empty-reply)' })
})

test('a refused Haiku call is recorded as an error', async ($, on) => {
  const { reviewRan, clock } = world(on, { files: judged, reviews: reviewing(), replies: [{ throws: true }] })
  await $.session.start(start)
  await clock.settle()
  expect(reviewRan[1]?.stdin).toEqual({ sessionId: 'old', error: 'Haiku call failed (HooksError)' })
})

test('a failed prompt step is logged and asks Haiku nothing', async ($, on) => {
  const { asked, logged, clock } = world(on, {
    files: judged,
    reviews: { prompt: { exitCode: 1, stdout: '', stderr: 'review-session: disk full\n' } },
  })
  await $.session.start(start)
  await clock.settle()
  expect(asked).toEqual([])
  expect(logged).toEqual(['session review failed (review-session prompt failed (exit 1): review-session: disk full)'])
})

test('a failed record is logged and the next review still runs', async ($, on) => {
  const { reviewRan, logged, clock } = world(on, {
    files: judged,
    reviews: reviewing([REVIEW, { ...REVIEW, sessionId: 'older' }], { exitCode: 1, stdout: '', stderr: 'review-session: no claimed review for old\n' }),
    replies: [{ isAnswered: true, text: '{"suggestions":[]}' }, { isAnswered: true, text: '{"suggestions":[]}' }],
  })
  await $.session.start(start)
  await clock.settle()
  expect(reviewRan.map((r) => r.argv[1])).toEqual(['prompt', 'record', 'record'])
  expect(logged).toEqual([
    'session review failed (review-session record failed (exit 1): review-session: no claimed review for old)',
    'session review failed (review-session record failed (exit 1): review-session: no claimed review for old)',
  ])
})

test('a /clear starts a review once record-session-end has run', async ($, on) => {
  const { ran, reviewRan, clock } = world(on, { files: judged })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(ran.map((r) => r.argv[0])).toEqual(['/repo/bin/record-session-end'])
  expect(reviewRan).toEqual([])
  await clock.settle()
  expect(reviewRan.map((r) => r.argv[1])).toEqual(['prompt'])
})

test('an exit leaves the review to the next session start', async ($, on) => {
  const { reviewRan, clock } = world(on, { files: judged })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.settle()
  expect(reviewRan).toEqual([])
})

test('a -p run starts no reviews', async ($, on) => {
  const { reviewRan, clock } = world(on, { files: judged, reviews: reviewing() })
  await $.session.start({ ...start, isInteractive: false })
  await clock.settle()
  expect(reviewRan).toEqual([])
})

test('an in-process /resume starts a review like /clear', async ($, on) => {
  const { reviewRan, clock } = world(on, { files: judged })
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await clock.settle()
  expect(reviewRan.map((r) => r.argv[1])).toEqual(['prompt'])
})

test('an api-error reply keeps its status in the recorded error', async ($, on) => {
  const { reviewRan, clock } = world(on, {
    files: judged,
    reviews: reviewing(),
    replies: [{ isAnswered: false, reason: 'api-error', status: 529, error: 'unknown' }],
  })
  await $.session.start(start)
  await clock.settle()
  expect(reviewRan[1]?.stdin).toEqual({ sessionId: 'old', error: 'Haiku gave no answer (api-error 529)' })
})

test('invalid JSON from review-session is logged without its text', async ($, on) => {
  const { logged, clock } = world(on, { files: judged, reviews: { prompt: { exitCode: 0, stdout: 'not json' } } })
  await $.session.start(start)
  await clock.settle()
  expect(logged).toEqual(['session review failed (review-session prompt printed invalid JSON)'])
})

const ACTIVITY = '/home/u/.claude/cc-dashboard/activity/s1.json'
const activityOf = (writes: Record<string, string>) => JSON.parse(writes[ACTIVITY] ?? 'null')
const turnEnd = (extra: object = {}) => ({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' as const, ...extra })
const idle = { sessionId: 's1', state: 'working', tool: null, subagents: 0 }

// Hooks queue activity writes and return without waiting for them, so each test
// settles the clock before it reads what was written.

test('turn.start records the session as working', async ($, on) => {
  const { writes, ran, clock } = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(activityOf(writes)).toEqual({ ...idle, since: 61_000, updatedAt: 61_000 })
  expect(ran).toEqual([])
})

for (const reason of ['answer', 'aborted', 'error'] as const) {
  test(`turn.complete with reason ${reason} records waiting`, async ($, on) => {
    const { writes, clock } = world(on)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await clock.advance(300)
    await $.turn.complete(turnEnd({ reason, isAborted: reason === 'aborted' }))
    await clock.settle()
    expect(activityOf(writes)).toEqual({ ...idle, state: 'waiting', since: 61_300, updatedAt: 61_300 })
  })
}

test('a turn.complete from a subagent leaves the state alone', async ($, on) => {
  const { writes, clock } = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(300)
  await $.turn.complete(turnEnd({ agentId: 'a1' }))
  await clock.settle()
  expect(activityOf(writes).state).toBe('working')
})

test('tool.call records the running tool and clears it when the tool returns', async ($, on) => {
  const { writes, clock, ran } = world(on, { toolMs: 1000 })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(300)
  const call = $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.settle()
  expect(activityOf(writes)).toEqual({
    ...idle, since: 61_000, updatedAt: 61_300, tool: { name: 'Bash', detail: 'npm test', startedAt: 61_300 },
  })
  await clock.advance(1000)
  await call
  await clock.settle()
  expect(activityOf(writes)).toEqual({ ...idle, since: 61_000, updatedAt: 62_300 })
  expect(ran).toEqual([])
})

test('a tool.call from a subagent leaves the recorded tool alone', async ($, on) => {
  const { writes, writeLog, clock } = world(on, { toolMs: 1000 })
  const main = $.tool.call({ tool: 'Bash', command: 'main' } as never)
  await clock.advance(300)
  const sub = $.tool.call({ tool: 'Bash', command: 'sub', agentId: 'a1' } as never)
  await clock.settle()
  expect(activityOf(writes).tool.detail).toBe('main')
  expect(writeLog.length).toBe(1)
  await clock.advance(1000)
  await Promise.all([main, sub])
})

test('the tool detail is the command, the file name, or empty', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000 })
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ tool: 'Bash', command: '  npm   test\n  --silent' }, 'npm test --silent'],
    [{ tool: 'Bash', command: 'x'.repeat(100) }, 'x'.repeat(60)],
    [{ tool: 'Read', file_path: '/work/src/app.ts' }, 'app.ts'],
    [{ tool: 'Edit', file_path: '/work/src/a.css', old_string: 'a', new_string: 'b' }, 'a.css'],
    [{ tool: 'Write', file_path: '/work/new.md', content: 'x' }, 'new.md'],
    [{ tool: 'Grep', pattern: 'secret' }, ''],
  ]
  for (const [input, detail] of cases) {
    await clock.advance(300)
    const call = $.tool.call(input as never)
    await clock.settle()
    expect(activityOf(writes).tool.detail).toBe(detail)
    await clock.advance(1000)
    await call
  }
})

test('with two tools running, the newer one shows, and the older one shows again when the newer ends', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000 })
  const first = $.tool.call({ tool: 'Bash', command: 'one' } as never)
  await clock.settle()
  await clock.advance(300)
  const second = $.tool.call({ tool: 'Bash', command: 'two' } as never)
  await clock.settle()
  expect(activityOf(writes).tool.detail).toBe('two')
  // The first ends at 62_000, 700 ms later. The second runs until 62_300.
  await clock.advance(700)
  await first
  await clock.settle()
  expect(activityOf(writes).tool.detail).toBe('two')
  await clock.advance(300)
  await second
  await clock.settle()
  expect(activityOf(writes).tool).toBe(null)
})

test('a burst of changes is written once at once and once more, with the latest state, after 250 ms', async ($, on) => {
  const { writes, writeLog, clock } = world(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await clock.settle()
  await $.turn.complete(turnEnd())
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.turn.complete(turnEnd({ turnId: 't2' }))
  await clock.settle()
  expect(writeLog.length).toBe(1)
  expect(activityOf(writes).state).toBe('working')
  await clock.advance(250)
  expect(writeLog.length).toBe(2)
  expect(activityOf(writes).state).toBe('waiting')
  await clock.advance(1000)
  expect(writeLog.length).toBe(2)
})

test('a slow write does not delay the hook, and the newer state is the last one written', async ($, on) => {
  const { writeLog, clock } = world(on, { writeMs: [500] })
  let returned = false
  void $.turn.start({ text: 'hi', turnId: 't1' }).then(() => {
    returned = true
  })
  await clock.settle()
  // The first write is still inside fs.write until 61_500.
  expect(returned).toBe(true)
  expect(writeLog).toEqual([])
  await clock.advance(300)
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(writeLog).toEqual([])
  await clock.advance(300)
  expect(writeLog.map((w) => JSON.parse(w.text).state)).toEqual(['working', 'waiting'])
})

test('CLAUDE_CONFIG_DIR moves the activity file', async ($, on) => {
  const { writes, clock } = world(on, { env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' } })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(Object.keys(writes)).toEqual(['/cfg/cc-dashboard/activity/s1.json'])
})

test('with neither HOME nor CLAUDE_CONFIG_DIR nothing is written and nothing is logged', async ($, on) => {
  const { writeLog, logged, clock } = world(on, { env: {} })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(writeLog).toEqual([])
  expect(logged).toEqual([])
})

test('a failing fs.write does not change the event result, and logs once', async ($, on) => {
  const { logged, clock } = world(on, { writeFails: true })
  expect(await $.turn.start({ text: 'hi', turnId: 't1' })).toEqual({ turnId: 't1' })
  await clock.advance(300)
  expect(await $.turn.start({ text: 'again', turnId: 't2' })).toEqual({ turnId: 't2' })
  await clock.settle()
  expect(logged).toEqual(['activity failed (HooksError)'])
})

test('a failing write from the throttle timer is logged and does not throw', async ($, on) => {
  const { logged, writeLog, state, clock } = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  state.writeFails = true
  expect(await $.turn.complete(turnEnd())).toEqual({ text: '' })
  await clock.settle()
  expect(logged).toEqual([])
  await clock.advance(250)
  expect(writeLog.length).toBe(1)
  expect(logged).toEqual(['activity failed (HooksError)'])
})

test('an ask verdict for the running tool records approval, and the tool returning goes back to working', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(300)
  const call = $.tool.call({ tool: 'Bash', command: 'rm x' } as never)
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' } })
  await clock.advance(300)
  expect(activityOf(writes)).toEqual({
    ...idle, state: 'approval', since: 61_300, updatedAt: 61_300,
    tool: { name: 'Bash', detail: 'rm x', startedAt: 61_300 },
  })
  await clock.advance(1000)
  await call
  expect(activityOf(writes).state).toBe('working')
  expect(activityOf(writes).tool).toBe(null)
})

test('an allow verdict leaves the state at working', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'allow' })
  const call = $.tool.call({ tool: 'Read', file_path: '/a/b.ts' } as never)
  await clock.settle()
  await $.tool.check({ tool: 'Read', input: { file_path: '/a/b.ts' } })
  await clock.advance(300)
  expect(activityOf(writes).state).toBe('working')
  await clock.advance(1000)
  await call
})

test('an ask for a tool that is not the running one, or with no tool running, records nothing', async ($, on) => {
  const { writes, writeLog, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  await clock.advance(300)
  expect(writeLog.length).toBe(0)
  const call = $.tool.call({ tool: 'Read', file_path: '/a/b.ts' } as never)
  await clock.settle()
  const before = writeLog.length
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  await clock.advance(300)
  expect(writeLog.length).toBe(before)
  expect(activityOf(writes).state).toBe('working')
  await clock.advance(1000)
  await call
})

test('an ask from a subagent records nothing', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  const call = $.tool.call({ tool: 'Bash', command: 'rm x' } as never)
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, agentId: 'a1' } as never)
  await clock.advance(300)
  expect(activityOf(writes).state).toBe('working')
  await clock.advance(1000)
  await call
})

test('an ask with a tool_use_id matches that tool, not the newest tool of the same name', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  const first = $.tool.call({ tool: 'Bash', command: 'one', tool_use_id: 'tu1' } as never)
  await clock.advance(300)
  const second = $.tool.call({ tool: 'Bash', command: 'two', tool_use_id: 'tu2' } as never)
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'one' }, tool_use_id: 'tu1' } as never)
  await clock.advance(300)
  expect(activityOf(writes).state).toBe('approval')
  // The second ends at 62_300 and the first, which asked, at 62_000.
  await clock.advance(400)
  await first
  await clock.advance(300)
  expect(activityOf(writes).state).toBe('working')
  await clock.advance(300)
  await second
})

test('approval stays while the asking tool runs, though another tool returns', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  const first = $.tool.call({ tool: 'Read', file_path: '/a/b.ts', tool_use_id: 'tu1' } as never)
  await clock.advance(300)
  const second = $.tool.call({ tool: 'Bash', command: 'rm x', tool_use_id: 'tu2' } as never)
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'tu2' } as never)
  await clock.advance(700)
  await first
  await clock.advance(250)
  expect(activityOf(writes).state).toBe('approval')
  await clock.advance(300)
  await second
  await clock.advance(250)
  expect(activityOf(writes).state).toBe('working')
})

test('an ask with a tool_use_id that is not running records nothing, though the name matches', async ($, on) => {
  const { writes, writeLog, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu1' } as never)
  await clock.settle()
  const before = writeLog.length
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'other' } as never)
  await clock.advance(300)
  expect(writeLog.length).toBe(before)
  expect(activityOf(writes).state).toBe('working')
  await clock.advance(1000)
  await call
})

test('subagents counts pending, running and waiting agents at each write', async ($, on) => {
  const agent = (id: string, status: AgentInfo['status']): AgentInfo => ({ id, description: 'd', type: 'Explore', status })
  const { writes, clock } = world(on, { agents: [agent('a1', 'running'), agent('a2', 'completed'), agent('a3', 'waiting'), agent('a4', 'idle')] })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(2)
})

test('subagents is recounted when an agent spawns and when a subagent turn ends', async ($, on) => {
  const { writes, state, clock } = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(0)
  state.agents = [{ id: 'a1', description: 'd', type: 'Explore', status: 'running' }]
  await clock.advance(300)
  await $.agent.spawn({ prompt: 'p' })
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(1)
  state.agents = []
  await clock.advance(300)
  await $.turn.complete(turnEnd({ agentId: 'a1' }))
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(0)
  expect(activityOf(writes).state).toBe('working')
})

test('session.end drops the session state, so a pending write never lands', async ($, on) => {
  const { writeLog, clock } = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(writeLog.length).toBe(1)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(1000)
  expect(writeLog.length).toBe(1)
})

test('after session.end the same id starts over: the next change writes at once, even with the same text', async ($, on) => {
  const { writeLog, clock } = world(on)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(writeLog.map((w) => w.text)).toEqual([writeLog[0]?.text, writeLog[0]?.text])
})

test('a subagent whose turn ended is left out of the count while agent.list still reports it running', async ($, on) => {
  const running = (id: string): AgentInfo => ({ id, description: 'd', type: 'Explore', status: 'running' })
  const { writes, state, clock } = world(on, { agents: [running('a1'), running('a2')] })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(2)
  await clock.advance(300)
  await $.turn.complete(turnEnd({ agentId: 'a1' }))
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(1)
  // The engine catches up and a2 ends too. a1 resumes under its id and counts again.
  state.agents = [{ ...running('a1'), status: 'completed' }, { ...running('a2'), status: 'completed' }]
  await clock.advance(300)
  await $.agent.spawn({ prompt: 'p' })
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(0)
  state.agents = [running('a1')]
  await clock.advance(300)
  await $.agent.spawn({ prompt: 'p' })
  await clock.settle()
  expect(activityOf(writes).subagents).toBe(1)
})

test('session.end drops the cached transcript path, so a later measure for that id searches again', async ($, on) => {
  const found = '/home/u/.claude/projects/-work-start-dir/s1.jsonl'
  const { listed } = world(on, {
    exists: (path) => path === found,
    dirs: { '/home/u/.claude/projects': ['-work-start-dir'] },
  })
  await $.session.measure(measure([FIVE]))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await $.session.measure(measure([FIVE]))
  expect(listed.length).toBe(2)
})

test('approval clears when the asking tool.call throws', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'ask', toolFails: true })
  const call = $.tool.call({ tool: 'Bash', command: 'rm x' } as never).catch(() => undefined)
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' } })
  await clock.advance(300)
  expect(activityOf(writes).state).toBe('approval')
  await clock.advance(1000)
  await call
  await clock.settle()
  expect(activityOf(writes).state).toBe('working')
  expect(activityOf(writes).tool).toBe(null)
})

test('a main-loop turn.complete clears approval', async ($, on) => {
  const { writes, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = $.tool.call({ tool: 'Bash', command: 'rm x' } as never)
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' } })
  await clock.advance(300)
  expect(activityOf(writes).state).toBe('approval')
  await $.turn.complete(turnEnd({ reason: 'aborted', isAborted: true }))
  await clock.advance(300)
  expect(activityOf(writes)).toMatchObject({ state: 'waiting', tool: null })
  await clock.advance(1000)
  await call
})

test('a subagent tool.call rewrites the file with the current count once it returns, and leaves waiting alone', async ($, on) => {
  const { writes, writeLog, state, clock } = world(on, { toolMs: 1000 })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(300)
  await $.turn.complete(turnEnd())
  await clock.advance(300)
  state.agents = [{ id: 'a1', description: 'd', type: 'Explore', status: 'running' }]
  const before = writeLog.length
  const sub = $.tool.call({ tool: 'Bash', command: 'sub', agentId: 'a1' } as never)
  await clock.settle()
  expect(writeLog.length).toBe(before)
  await clock.advance(1000)
  await sub
  await clock.settle()
  expect(activityOf(writes)).toEqual({ ...idle, state: 'waiting', since: 61_300, subagents: 1, updatedAt: 62_600 })
})

test('with no session state yet, subagent events and an unmatched check write nothing', async ($, on) => {
  // A fresh module after a hot reload, while the main loop waits on a subagent.
  const { writeLog, state, clock } = world(on, { verdict: 'ask' })
  state.agents = [{ id: 'a1', description: 'd', type: 'Explore', status: 'running' }]
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  await $.agent.spawn({ prompt: 'p' })
  await $.tool.call({ tool: 'Bash', command: 'sub', agentId: 'a1' } as never)
  await $.turn.complete(turnEnd({ agentId: 'a1' }))
  await clock.advance(1000)
  expect(writeLog).toEqual([])
})

test('a throttle timer that fires as the session ends leaves nothing behind for that id', async ($, on) => {
  // Holds the mock clock's clock.now answer while `held` is set, and resolves
  // `reached` when a held call arrives.
  let held: Promise<void> | undefined
  let release = () => {}
  let reached = () => {}
  const gated = ((event: string, ...rest: unknown[]) => {
    const hook = rest.pop() as (...args: unknown[]) => unknown
    const wrapped = event === 'clock.now'
      ? async (...args: unknown[]) => {
        if (held) {
          reached()
          await held
        }
        return hook(...args)
      }
      : hook
    return (on as (...args: unknown[]) => unknown)(event, ...rest, wrapped)
  }) as unknown as On
  const { writeLog, clock } = world(gated)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await clock.settle()
  await $.turn.complete(turnEnd())
  held = new Promise((resolve) => {
    release = resolve
  })
  const timerAsked = new Promise<void>((resolve) => {
    reached = resolve
  })
  // The timer fires at 61_250 and asks for the time. session.end runs before the
  // answer arrives.
  const advanced = clock.advance(250)
  await timerAsked
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  held = undefined
  release()
  await advanced
  await clock.settle()
  const before = writeLog.length
  await $.turn.start({ text: 'b', turnId: 't2' })
  await clock.settle()
  expect(writeLog.length).toBe(before + 1)
})
