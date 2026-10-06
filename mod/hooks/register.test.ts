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
  files: Record<string, string>
  version: { version: string; base?: string }
  fetch: () => { status: number; ok: boolean; text: string }
  registerFails: boolean
  // `throws` makes model.complete reject, as an engine refusal does.
  replies: Array<
    | { isAnswered: true; text: string }
    | { isAnswered: false; reason: 'api-error'; status: null; error: 'unknown' }
    | { isAnswered: false; reason: 'empty-reply' | 'aborted' }
    | { throws: true }
  >
  scripts: Record<string, { exitCode: number; stdout: string; stderr?: string }>
  // The plugin's key-value store, which $.store.get and $.store.set read and write.
  store: Record<string, unknown>
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
    store: {},
    ...w,
  }
  const ran: Ran[] = []
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
  return { ran, state, listed, endSawRan, clock, fetched, asked, registered, logged }
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
  expect(logged).toEqual(['cc-dashboard: transcript not found'])
})

test('a measure without cost on a missing transcript logs nothing, and a later one with cost still logs', async ($, on) => {
  const { ran, logged } = world(on, { exists: () => false, dirs: { '/home/u/.claude/projects': ['-work-my-demo'] } })
  await $.session.measure(measure([FIVE], null))
  expect(ran).toEqual([])
  expect(logged).toEqual([])
  await $.session.measure(measure([FIVE]))
  expect(logged).toEqual(['cc-dashboard: transcript not found'])
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
  expect(logged).toEqual(['cc-dashboard: record-statusline failed (exit 1)'])
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
  expect(logged).toEqual(['cc-dashboard: changelog fetch returned 503'])
})

test('a Haiku call with no answer records nothing and logs the reason', async ($, on) => {
  const { ran, logged, clock } = world(on, { scripts: judging, replies: [{ isAnswered: false, reason: 'api-error', status: null, error: 'unknown' }] })
  await $.session.start(start)
  await clock.settle()
  expect(ran.map((r) => r.argv[1])).toEqual(['prompt'])
  expect(logged).toEqual(['cc-dashboard: Haiku gave no verdict for 2.1.290 (api-error)'])
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
  expect(logged).toEqual(['cc-dashboard: changelog fetch failed (HooksError)'])
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
  expect(logged).toEqual([`cc-dashboard: ${UPDATES} is not valid JSON; fix or delete it`])
})

test('an updates.json holding an array or null logs and fetches nothing', async ($, on) => {
  for (const content of ['[]', 'null']) {
    const { fetched, asked, logged, clock } = world(on, { files: { [UPDATES]: content } })
    await $.session.start(start)
    await clock.settle()
    expect(fetched).toEqual([])
    expect(asked).toEqual([])
    expect(logged).toEqual([`cc-dashboard: ${UPDATES} is not a JSON object; fix or delete it`])
  }
})

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
  clock.advance(HOUR)
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
  expect(logged).toEqual(['cc-dashboard: could not register /backfill-updates (HooksError)'])
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
