import type { AgentInfo, EngineInterface, On, SessionRateLimit, UsageUnit } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import { snapshotName } from './setup'

type Ran = { argv: readonly string[]; stdin: unknown; timeoutMs: number | undefined }
type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }
// `exists` answers fs.exists. `dirs` maps a folder to the names fs.list returns for it.
type World = {
  id: string
  model: string
  env: Record<string, string>
  exists: (path: string) => boolean
  turns: () => number
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
  // Files that fs.stat finds, by path, with their mtimeMs. Other paths stat as the plugin's folder.
  stats: Record<string, number>
  // What $.session.cwd returns.
  cwd: string
  // Answers process.run for git and date, keyed by argv joined with spaces. A command
  // not listed exits 0 with no output. These runs go to commandRan, so `ran` keeps
  // only bin/ scripts.
  commands: Record<string, { exitCode: number; stdout: string; stderr?: string }>
  // model.fork replies in call order. `throws` makes the call reject. With none left,
  // the fork answers nothing-to-fork.
  forks: Array<
    | { isAnswered: true; text: string }
    | { isAnswered: false; reason: 'nothing-to-fork' | 'empty-reply' | 'aborted' }
    | { throws: true }
  >
  // How long each fork takes on the mock clock.
  forkMs: number
  // The input box's text, which $.prompt.read returns.
  draft: string
  // context.tokens in $.session.usage(). Undefined leaves it out, as before a response.
  contextTokens: number | undefined
  // Answers bin/cache-state. Its runs go to cacheRan. cacheMs delays the answer on the mock clock.
  cacheState: { exitCode: number; stdout: string; stderr?: string }
  cacheMs: number
}

const entry = (name: string): Entry => ({ name, kind: name.endsWith('.md') ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })

const FIVE: SessionRateLimit = { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-01T15:00:00.000Z' }
const WEEK: SessionRateLimit = { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-05T09:30:00.000Z' }

// contract:begin
const CONTRACT = [
  { "script": "judge-updates", "args": ["prompt", "--current", "2.1.290"], "stdin": "## 2.1.290\n- Compaction keeps fewer tool results" },
  { "script": "judge-updates", "args": ["prompt"], "stdin": "## 2.1.290\n- Compaction keeps fewer tool results" },
  { "script": "judge-updates", "args": ["record"], "stdin": { "versions": ["2.1.290"], "reply": "[{\"version\":\"2.1.290\",\"relevant\":false}]" } },
  { "script": "review-session", "args": ["prompt"], "stdin": "" },
  { "script": "review-session", "args": ["record"], "stdin": { "sessionId": "abc", "reply": "{\"suggestions\":[]}" } },
  { "script": "cache-state", "args": [], "stdin": { "transcript": "/nonexistent/abc.jsonl" } },
  { "script": "record-session-end", "args": [], "stdin": { "session_id": "abc", "reason": "clear" } },
  { "script": "record-statusline", "args": [], "stdin": {
    "session_id": "abc", "launch_id": "mfz3k1-a8c2e9f0", "cleared_from": "prev-1", "transcript_path": "/nonexistent/abc.jsonl", "workspace": { "project_dir": "/work/demo" },
    "model": { "display_name": "Opus 5.5 (1M context)" }, "cost": { "total_cost_usd": 0.42, "total_duration_ms": 60000 },
    "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1790866800 }, "seven_day": { "used_percentage": 41, "resets_at": 1791192600 } } } },
]
// contract:end
const contract = CONTRACT

// Answers every noun the mod calls, beneath it. `w` is read on each call, so a
// test can change the session id, the model or the environment between events.
// Returns what process.run got and the folders fs.list was asked for.
function world(on: On, w: Partial<World> = {}, exitCode = 0, runThrows = false) {
  const state: World = {
    id: 's1',
    model: 'claude-opus-5-5[1m]',
    env: { HOME: '/home/u' },
    exists: () => true,
    turns: () => 1,
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
    stats: {},
    cwd: '/work/my.demo',
    commands: {},
    forks: [],
    forkMs: 0,
    draft: '',
    contextTokens: undefined,
    cacheState: { exitCode: 0, stdout: '{}' },
    cacheMs: 0,
    ...w,
  }
  const ran: Ran[] = []
  const commandRan: string[] = []
  const forked: string[] = []
  const statuses: (string | undefined)[] = []
  const fills: string[] = []
  const reviewRan: Ran[] = []
  const cacheRan: Ran[] = []
  const endSawRan: number[] = []
  const listed: string[] = []
  const readLog: string[] = []
  const clock = mock.clock(on, { now: 61_000 })
  // The component core draws when no plugin does. A $.ui.mount needs it beneath the plugins.
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('fs.stat', (_$, e) => {
    const mtimeMs = state.stats[e.path]
    if (mtimeMs !== undefined) return { value: { kind: 'file' as const, size: 1, mtimeMs, isLink: false } }
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: '/repo/mod' } }
  })
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
    readLog.push(e.path)
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
  on('model.fork', async (_$, e) => {
    forked.push(e.prompt)
    if (state.forkMs > 0) await clock.sleep(state.forkMs)
    const reply = state.forks.shift() ?? { isAnswered: false as const, reason: 'nothing-to-fork' as const }
    if ('throws' in reply) throw new Error('refused')
    return { value: { ...reply, usage } }
  })
  on('session.compact', (_$, e) => ({ messages: e.messages }))
  on('session.cwd', () => ({ value: state.cwd }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: state.draft, cursor: state.draft.length } }))
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('store.get', (_$, e) => ({ value: state.store[e.key] }))
  on('store.set', (_$, e) => {
    state.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete state.store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(state.store) }))
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
  on('session.turns', () => ({ value: state.turns() }))
  on('session.usage', () => ({
    value: { startedAt: 1_000, context: { window: 200_000, ...(state.contextTokens === undefined ? {} : { tokens: state.contextTokens }) }, rateLimits: [] },
  }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', async (_$, e) => {
    // Gives a script that has started a few ticks to reach process.run first.
    for (let tick = 0; tick < 500; tick++) await Promise.resolve()
    endSawRan.push(ran.length)
    return { sessionId: e.sessionId }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'git' || e.argv[0] === 'date') {
      const key = e.argv.join(' ')
      commandRan.push(key)
      const out = state.commands[key] ?? { exitCode: 0, stdout: '' }
      return { value: { stderr: '', ...out, isStdoutTruncated: false, isStderrTruncated: false } }
    }
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
    if (e.argv[0]?.endsWith('/cache-state')) {
      cacheRan.push({ argv: e.argv, stdin: e.init?.stdin === undefined ? undefined : JSON.parse(e.init.stdin), timeoutMs: e.init?.timeoutMs })
      if (state.cacheMs > 0) await clock.sleep(state.cacheMs)
      return { value: { stderr: '', ...state.cacheState, isStdoutTruncated: false, isStderrTruncated: false } }
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
  return { ran, reviewRan, cacheRan, state, listed, readLog, endSawRan, clock, fetched, asked, registered, logged, writes, writeLog, commandRan, forked, statuses, fills }
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
  const { launch_id, ...stdin } = ran[0].stdin as Record<string, unknown>
  expect(typeof launch_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(launch_id)).toBe(true)
  expect([{ ...ran[0], stdin }]).toEqual([{
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
  expect(ran.length).toBe(1)
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

test('a transcript that exists nowhere after a prompt records nothing and logs once', async ($, on) => {
  const { ran, logged } = world(on, { exists: () => false, dirs: { '/home/u/.claude/projects': ['-work-my-demo'] } })
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(ran).toEqual([])
  expect(logged).toEqual(['transcript not found'])
})

test('a fresh session with no transcript yet logs nothing, and one after a prompt still logs', async ($, on) => {
  // Claude Code's first measure names every unit it has a figure for, so it carries
  // cost { usd: 0 } before the first prompt writes the transcript.
  let turns = 0
  const { ran, logged } = world(on, { exists: () => false, turns: () => turns, dirs: { '/home/u/.claude/projects': ['-work-my-demo'] } })
  await $.session.measure(measure([FIVE], { usd: 0 }))
  expect(ran).toEqual([])
  expect(logged).toEqual([])
  turns = 1
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

test('after a /clear the next measure keeps the same launch_id', async ($, on) => {
  const { ran, state } = world(on)
  await $.session.measure(measure([FIVE]))
  state.id = 's2'
  await $.session.measure(measure([FIVE]))
  const sent = ran.map((r) => r.stdin as { session_id: string; launch_id: string })
  expect(sent.map((s) => s.session_id)).toEqual(['s1', 's2'])
  expect(typeof sent[0].launch_id).toBe('string')
  expect(sent[1].launch_id).toBe(sent[0].launch_id)
})

// The stdin of each record-statusline run, in order. ran also holds record-session-end runs.
const statuslines = (ran: Ran[]) => ran.filter((r) => r.argv[0] === '/repo/bin/record-statusline').map((r) => r.stdin as Record<string, unknown>)

test('after a /clear the new session\'s measures send cleared_from', async ($, on) => {
  const { ran, state } = world(on)
  await $.session.measure(measure([FIVE]))
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  state.id = 's2'
  await $.session.measure(measure([FIVE]))
  await $.session.measure(measure([FIVE]))
  expect(statuslines(ran).map((s) => s.cleared_from ?? null)).toEqual([null, 's1', 's1'])
})

test('a /clear of a session this process never measured still links the new session', async ($, on) => {
  const { ran, state } = world(on)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  state.id = 's2'
  await $.session.measure(measure([FIVE]))
  expect(statuslines(ran).map((s) => s.cleared_from ?? null)).toEqual(['s1'])
})

test('two /clears with no prompt between link the new session to the first one', async ($, on) => {
  const { ran, state } = world(on, { exists: (path) => !path.endsWith('/s2.jsonl') })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.session.end({ reason: 'clear', sessionId: 's2', resume: { id: 's2' } })
  state.id = 's3'
  await $.session.measure(measure([FIVE]))
  expect(statuslines(ran).map((s) => s.cleared_from ?? null)).toEqual(['s1'])
})

test('after an in-process /resume the next measure sends no cleared_from', async ($, on) => {
  const { ran, state } = world(on)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's3' } })
  state.id = 's3'
  await $.session.measure(measure([FIVE]))
  expect(statuslines(ran).map((s) => s.cleared_from ?? null)).toEqual([null])
})

test('a measure of the cleared session itself sends no cleared_from', async ($, on) => {
  const { ran } = world(on)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.session.measure(measure([FIVE]))
  expect(statuslines(ran).map((s) => s.cleared_from ?? null)).toEqual([null])
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

test('CLAUDE_CONFIG_DIR moves the verdict file the check reads', async ($, on) => {
  const { fetched, asked, clock } = world(on, {
    env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' },
    files: { '/cfg/cc-dashboard/updates.json': '{"2.1.290":{"relevant":false}}' },
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

// Every call the mod makes to a bin/ script, as script name, args and the shape of its
// stdin: the word 'text' for plain text, otherwise the sorted top-level keys.
// test/mod-contract.test.js runs the same entries against the real scripts.
const stdinShape = (stdin: unknown) => (typeof stdin === 'string' ? 'text' : Object.keys((stdin ?? {}) as object).sort())
const callKey = (c: { script: string; args: readonly string[]; stdin: unknown }) => JSON.stringify([c.script, c.args, stdinShape(c.stdin)])

test('the mod makes exactly the script calls listed in CONTRACT', async ($, on) => {
  const { ran, reviewRan, cacheRan, clock, state } = world(on, {
    contextTokens: 60_000,
    scripts: judging,
    reviews: reviewing(),
    replies: [{ isAnswered: true, text: VERDICT }, { isAnswered: true, text: VERDICT }, { isAnswered: true, text: '{"suggestions":[]}' }, { isAnswered: true, text: '{"suggestions":[]}' }],
  })
  await $.command.run(backfill)
  await $.session.start(start)
  await clock.settle()
  // A finished turn runs bin/cache-state once the arming delay has passed.
  await $.turn.complete(turnEnd())
  await clock.advance(1_000)
  // Only a measure after a /clear sends cleared_from, so the one measure here follows one.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  state.id = 's2'
  await $.session.measure(measure([FIVE, WEEK]))
  await clock.settle()
  const made = [...ran, ...reviewRan, ...cacheRan].map((r) =>
    callKey({ script: r.argv[0]?.split('/').pop() ?? '', args: r.argv.slice(1), stdin: r.stdin }),
  )
  expect([...new Set(made)].sort()).toEqual(contract.map(callKey).sort())
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

test('an ask verdict leaves the state at working, because the mod cannot tell whether a dialog opens', async ($, on) => {
  const { writes, writeLog, clock } = world(on, { toolMs: 1000, verdict: 'ask' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(300)
  const call = $.tool.call({ tool: 'Bash', command: 'rm x', tool_use_id: 'tu1' } as never)
  await clock.settle()
  const before = writeLog.length
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'tu1' } as never)
  await clock.advance(300)
  expect(writeLog.length).toBe(before)
  expect(activityOf(writes)).toMatchObject({ state: 'working', tool: { name: 'Bash', detail: 'rm x' } })
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

test('with no session state yet, subagent events write nothing', async ($, on) => {
  // A fresh module after a hot reload, while the main loop waits on a subagent.
  const { writeLog, state, clock } = world(on)
  state.agents = [{ id: 'a1', description: 'd', type: 'Explore', status: 'running' }]
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

const CFG = '/home/u/.claude'
const CLAUDE_MD = `${CFG}/CLAUDE.md`
const SETTINGS = `${CFG}/settings.json`
const CHANGES = `${CFG}/cc-dashboard/changes/s1.json`
const snap = (path: string) => `${CFG}/cc-dashboard/setup/${snapshotName(path)}`
const snapText = (path: string, mtimeMs: number, text: string | null) => JSON.stringify({ path, mtimeMs, text })

async function startAndSettle($: EngineInterface, clock: { settle: () => Promise<void> }) {
  await $.session.start(start)
  await clock.settle()
}

test('the first setup check stores snapshots and writes no marker', async ($, on) => {
  const { writes, state, clock } = world(on, { files: { ...judged, [CLAUDE_MD]: 'a' }, stats: { [CLAUDE_MD]: 1000 } })
  await startAndSettle($, clock)
  expect(writes[CHANGES]).toBe(undefined)
  expect(JSON.parse(writes[snap(CLAUDE_MD)] ?? 'null')).toEqual({ path: CLAUDE_MD, mtimeMs: 1000, text: 'a' })
  const setup = state.store.setup as { folders: string[]; mtimes: Record<string, number | null> }
  expect(setup.mtimes[CLAUDE_MD]).toBe(1000)
  expect(setup.folders).toContain(CFG)
  expect(setup.folders).toContain('/work/my.demo')
})

test('an edited CLAUDE.md gets a Haiku label dated to its mtime', async ($, on) => {
  const { writes, asked, clock } = world(on, {
    files: { ...judged, [CLAUDE_MD]: 'a\nb', [snap(CLAUDE_MD)]: snapText(CLAUDE_MD, 1000, 'a') },
    stats: { [CLAUDE_MD]: 2000 },
    store: { setup: { folders: [CFG], mtimes: { [CLAUDE_MD]: 1000 } } },
    replies: [{ isAnswered: true, text: 'add rule b' }],
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([
    { t: 2000, kind: 'claude-md', name: 'CLAUDE.md', label: 'add rule b', file: CLAUDE_MD },
  ])
  expect(asked.length).toBe(1)
  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.effort).toBe('medium')
  expect(asked[0]?.timeoutMs).toBe(15_000)
  expect(asked[0]?.prompt).toContain('Added lines:\nb')
  expect(JSON.parse(writes[snap(CLAUDE_MD)] ?? 'null')).toEqual({ path: CLAUDE_MD, mtimeMs: 2000, text: 'a\nb' })
})

test('a failing Haiku call falls back to the first added line', async ($, on) => {
  const { writes, clock } = world(on, {
    files: { ...judged, [CLAUDE_MD]: 'a\n- use cx', [snap(CLAUDE_MD)]: snapText(CLAUDE_MD, 1000, 'a') },
    stats: { [CLAUDE_MD]: 2000 },
    store: { setup: { folders: [CFG], mtimes: { [CLAUDE_MD]: 1000 } } },
    replies: [{ throws: true }],
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')[0]?.label).toBe('use cx')
})

test('a settings.json edit is split by kind with no Haiku call', async ($, on) => {
  const before = JSON.stringify({ theme: 'dark', modelSettings: { m: { effortLevel: 'high' } } })
  const after = JSON.stringify({ theme: 'light', modelSettings: { m: { effortLevel: 'medium' } }, enabledPlugins: { p: true } })
  const { writes, asked, clock } = world(on, {
    files: { ...judged, [SETTINGS]: after, [snap(SETTINGS)]: snapText(SETTINGS, 1000, before) },
    stats: { [SETTINGS]: 3000 },
    store: { setup: { folders: [CFG], mtimes: { [SETTINGS]: 1000 } } },
  })
  await startAndSettle($, clock)
  expect(asked.length).toBe(0)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([
    { t: 3000, kind: 'config', name: 'settings.json', label: 'theme dark → light', file: SETTINGS },
    { t: 3000, kind: 'effort', name: 'settings.json', label: 'modelSettings.m.effortLevel high → medium', file: SETTINGS },
  ])
})

test('a new skill in a folder seen before is marked added', async ($, on) => {
  const skill = `${CFG}/skills/dataviz/SKILL.md`
  const { writes, asked, clock } = world(on, {
    files: { ...judged, [skill]: 'x' },
    stats: { [skill]: 4000 },
    dirs: { [`${CFG}/skills`]: ['dataviz'] },
    store: { setup: { folders: [CFG, `${CFG}/skills`], mtimes: {} } },
  })
  await startAndSettle($, clock)
  expect(asked.length).toBe(0)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 4000, kind: 'skill', name: 'skill dataviz', label: 'added', file: skill }])
})

test('an added skill with an old mtime is dated to the previous check of its folder', async ($, on) => {
  const skill = `${CFG}/skills/dataviz/SKILL.md`
  const { writes, state, clock } = world(on, {
    files: { ...judged, [skill]: 'x' },
    stats: { [skill]: 4000 },
    dirs: { [`${CFG}/skills`]: ['dataviz'] },
    store: { setup: { folders: [CFG, `${CFG}/skills`], mtimes: {}, checked: { [`${CFG}/skills`]: 50_000 } } },
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 50_000, kind: 'skill', name: 'skill dataviz', label: 'added', file: skill }])
  expect((state.store.setup as { checked: Record<string, number> }).checked[CFG]).toBe(61_000)
})

test('a file with an index entry and a lost snapshot is a baseline, not added', async ($, on) => {
  const { writes, clock } = world(on, {
    files: { ...judged, [CLAUDE_MD]: 'a' },
    stats: { [CLAUDE_MD]: 2000 },
    store: { setup: { folders: [CFG], mtimes: { [CLAUDE_MD]: 1000 } } },
  })
  await startAndSettle($, clock)
  expect(writes[CHANGES]).toBe(undefined)
  expect(JSON.parse(writes[snap(CLAUDE_MD)] ?? 'null')).toEqual({ path: CLAUDE_MD, mtimeMs: 2000, text: 'a' })
})

test('a hook script that was missing at the last check is marked added with its name', async ($, on) => {
  const script = '/home/u/bin/guard.sh'
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '~/bin/guard.sh --x' }] }] } })
  const { writes, clock } = world(on, {
    files: { ...judged, [SETTINGS]: settings, [snap(SETTINGS)]: snapText(SETTINGS, 1000, settings), [script]: 'new' },
    stats: { [SETTINGS]: 1000, [script]: 5000 },
    store: { setup: { folders: [CFG], mtimes: { [SETTINGS]: 1000, [script]: null } } },
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 5000, kind: 'hook', name: 'hook script', label: 'guard.sh added', file: script }])
})

test('a deleted skill folder is marked removed', async ($, on) => {
  const skill = `${CFG}/skills/dataviz/SKILL.md`
  const { writes, clock } = world(on, {
    files: { ...judged, [snap(skill)]: snapText(skill, 4000, 'x') },
    store: { setup: { folders: [CFG, `${CFG}/skills`], mtimes: { [skill]: 4000 } } },
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 61_000, kind: 'skill', name: 'skill dataviz', label: 'removed', file: skill }])
  expect(JSON.parse(writes[snap(skill)] ?? 'null')).toEqual({ path: skill, mtimeMs: 0, text: null })
})

test('a hook script named in settings.json is watched', async ($, on) => {
  const script = '/home/u/bin/guard.sh'
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '~/bin/guard.sh --x' }] }] } })
  const { writes, clock } = world(on, {
    files: { ...judged, [SETTINGS]: settings, [snap(SETTINGS)]: snapText(SETTINGS, 1000, settings), [script]: 'new', [snap(script)]: snapText(script, 4000, 'old') },
    stats: { [SETTINGS]: 1000, [script]: 5000 },
    store: { setup: { folders: [CFG], mtimes: { [SETTINGS]: 1000, [script]: 4000 } } },
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 5000, kind: 'hook', name: 'hook script', label: 'guard.sh changed', file: script }])
})

test("the project's CLAUDE.md is watched with the project's name", async ($, on) => {
  const file = '/work/my.demo/CLAUDE.md'
  const { writes, clock } = world(on, {
    files: { ...judged, [file]: 'a\nb', [snap(file)]: snapText(file, 1000, 'a') },
    stats: { [file]: 2000 },
    store: { setup: { folders: [CFG, '/work/my.demo'], mtimes: { [file]: 1000 } } },
    replies: [{ isAnswered: true, text: 'add b' }],
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 2000, kind: 'claude-md', name: 'my.demo/CLAUDE.md', label: 'add b', file }])
})

test('a project seen for the first time is a baseline', async ($, on) => {
  const file = '/work/my.demo/CLAUDE.md'
  const { writes, clock } = world(on, {
    files: { ...judged, [file]: 'a' },
    stats: { [file]: 2000 },
    store: { setup: { folders: [CFG], mtimes: {} } },
  })
  await startAndSettle($, clock)
  expect(writes[CHANGES]).toBe(undefined)
  expect(JSON.parse(writes[snap(file)] ?? 'null')?.text).toBe('a')
})

test('an unchanged mtime reads neither the file nor its snapshot', async ($, on) => {
  const rule = `${CFG}/rules/style.md`
  const { readLog, writes, clock } = world(on, {
    files: { ...judged, [rule]: 'a', [snap(rule)]: snapText(rule, 1000, 'a') },
    stats: { [rule]: 1000 },
    dirs: { [`${CFG}/rules`]: ['style.md'] },
    store: { setup: { folders: [CFG, `${CFG}/rules`], mtimes: { [rule]: 1000 } } },
  })
  await startAndSettle($, clock)
  expect(readLog).not.toContain(rule)
  expect(readLog).not.toContain(snap(rule))
  expect(writes[CHANGES]).toBe(undefined)
})

test('a resumed session appends to its marker file', async ($, on) => {
  const earlier = { t: 500, kind: 'rtk', name: 'rtk config.toml', label: 'x', file: '/f' }
  const { writes, clock } = world(on, {
    files: { ...judged, [CHANGES]: JSON.stringify([earlier]), [CLAUDE_MD]: 'a\nb', [snap(CLAUDE_MD)]: snapText(CLAUDE_MD, 1000, 'a') },
    stats: { [CLAUDE_MD]: 2000 },
    store: { setup: { folders: [CFG], mtimes: { [CLAUDE_MD]: 1000 } } },
    replies: [{ isAnswered: true, text: 'add b' }],
  })
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]').map((e: { label: string }) => e.label)).toEqual(['x', 'add b'])
})

test('a failed marker write leaves the snapshots and the index as they were', async ($, on) => {
  const { writes, state, logged, clock } = world(on, {
    files: { ...judged, [CLAUDE_MD]: 'a\nb', [snap(CLAUDE_MD)]: snapText(CLAUDE_MD, 1000, 'a') },
    stats: { [CLAUDE_MD]: 2000 },
    store: { setup: { folders: [CFG], mtimes: { [CLAUDE_MD]: 1000 } } },
    replies: [{ isAnswered: true, text: 'add b' }],
    writeFails: true,
  })
  await startAndSettle($, clock)
  expect(writes[snap(CLAUDE_MD)]).toBe(undefined)
  expect((state.store.setup as { mtimes: Record<string, number> }).mtimes[CLAUDE_MD]).toBe(1000)
  expect(logged.some((line) => line.startsWith('setup check failed'))).toBe(true)
})

test('a non-interactive session runs no setup check', async ($, on) => {
  const { state, clock } = world(on, { files: { ...judged, [CLAUDE_MD]: 'a' }, stats: { [CLAUDE_MD]: 1000 } })
  await $.session.start({ ...start, isInteractive: false })
  await clock.settle()
  expect(state.store.setup).toBe(undefined)
})

test('the first rule in a folder that was empty at the first check is marked added', async ($, on) => {
  const rule = `${CFG}/rules/x.md`
  const { writes, state, clock } = world(on, { files: { ...judged } })
  await startAndSettle($, clock)
  state.files[rule] = 'a'
  state.stats[rule] = 5000
  state.dirs[`${CFG}/rules`] = ['x.md']
  await startAndSettle($, clock)
  expect(JSON.parse(writes[CHANGES] ?? '[]')).toEqual([{ t: 61_000, kind: 'claude-md', name: 'rules/x.md', label: 'added', file: rule }])
})

const REPO = {
  'git rev-parse --show-toplevel': { exitCode: 0, stdout: '/work/my.demo\n' },
  'git branch --show-current': { exitCode: 0, stdout: 'feat/Handoff X\n' },
  'date +%Y-%m-%d-%H%M%S': { exitCode: 0, stdout: '2026-10-12-154500\n' },
}
const HANDOFF = '/work/my.demo/.claude/handoffs/2026-10-12-154500-feat-handoff-x.md'
const DOC = { isAnswered: true as const, text: '# Handoff: demo\n\nbody\n' }
const READY = 'handoff ready · /clear to resume'
const compacting = (over: { trigger?: 'auto' | 'manual'; agentId?: string } = {}) => ({
  trigger: 'auto' as const,
  messages: [{ role: 'user' as const, text: 'hi', toolUses: [] }],
  ...over,
})
// One finished main-thread turn, which leaves the session waiting. Named idleTurn
// because this file already has a constant called idle.
async function idleTurn($: EngineInterface) {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turnEnd())
}

test('an idle auto compaction writes a handoff from a fork and shows the status', async ($, on) => {
  const { writes, forked, statuses, commandRan, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(commandRan).toContain('git rev-parse --show-toplevel')
  expect(commandRan).toContain('date +%Y-%m-%d-%H%M%S')
  expect(forked.length).toBe(1)
  expect(forked[0]).toContain('feat/Handoff X')
  expect(writes[HANDOFF]).toBe('# Handoff: demo\n\nbody\n')
  expect(statuses).toEqual([undefined, READY])
})

test('the first turn after a load clears the status once, for a status an earlier load left', async ($, on) => {
  const { statuses } = world(on)
  await idleTurn($)
  await idleTurn($)
  expect(statuses).toEqual([undefined])
})

test('the compaction passes on before the fork answers', async ($, on) => {
  const { writes, clock } = world(on, { commands: REPO, forks: [DOC], forkMs: 30_000 })
  await idleTurn($)
  const result = await $.session.compact(compacting())
  expect(result.messages.length).toBe(1)
  await clock.advance(1_000)
  expect(writes[HANDOFF]).toBe(undefined)
  await clock.advance(30_000)
  await clock.settle()
  expect(writes[HANDOFF]).toBe('# Handoff: demo\n\nbody\n')
})

test('a manual compaction writes no handoff', async ($, on) => {
  const { forked, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting({ trigger: 'manual' }))
  await clock.settle()
  expect(forked).toEqual([])
})

test('an auto compaction during a turn writes no handoff', async ($, on) => {
  const { forked, clock } = world(on, { commands: REPO, forks: [DOC] })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked).toEqual([])
})

test('a subagent compaction writes no handoff', async ($, on) => {
  const { forked, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting({ agentId: 'a1' }))
  await clock.settle()
  expect(forked).toEqual([])
})

test('with no session state, as after a reload, compaction passes on and writes nothing', async ($, on) => {
  const { forked, logged, clock } = world(on, { commands: REPO, forks: [DOC] })
  const result = await $.session.compact(compacting())
  await clock.settle()
  expect(result.messages.length).toBe(1)
  expect(forked).toEqual([])
  expect(logged).toEqual([])
})

test('a second idle compaction before the next turn writes nothing more', async ($, on) => {
  const { forked, clock } = world(on, { commands: REPO, forks: [DOC, DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked.length).toBe(1)
})

test('after the next turn, a later idle compaction writes again and the status clears in between', async ($, on) => {
  const { forked, statuses, clock } = world(on, { commands: REPO, forks: [DOC, DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked.length).toBe(2)
  expect(statuses).toEqual([undefined, READY, undefined, READY])
})

test('a fork with no answer writes nothing, sets no status and logs the reason', async ($, on) => {
  const { writes, statuses, logged, clock } = world(on, { commands: REPO, forks: [{ isAnswered: false, reason: 'empty-reply' }] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(writes[HANDOFF]).toBe(undefined)
  expect(statuses).toEqual([undefined])
  expect(logged).toEqual(['handoff failed (fork empty-reply)'])
})

test('a fork that rejects is logged, and no retry runs in the same idle gap', async ($, on) => {
  const { forked, logged, clock } = world(on, { commands: REPO, forks: [{ throws: true }, DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked.length).toBe(1)
  // The engine may wrap the handler's error message, so only the prefix is fixed.
  expect(logged.length).toBe(1)
  expect(logged[0]).toMatch(/^handoff failed \(/)
})

test('a blank fork reply counts as no answer', async ($, on) => {
  const { writes, logged, clock } = world(on, { commands: REPO, forks: [{ isAnswered: true, text: '  \n' }] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(writes[HANDOFF]).toBe(undefined)
  expect(logged).toEqual(['handoff failed (fork empty)'])
})

test('without a timestamp no fork runs', async ($, on) => {
  const commands = { ...REPO, 'date +%Y-%m-%d-%H%M%S': { exitCode: 1, stdout: '', stderr: 'date: failed' } }
  const { forked, logged, clock } = world(on, { commands, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked).toEqual([])
  expect(logged).toEqual(['handoff failed (no timestamp)'])
})

test('outside a git repo the handoff goes under cwd with no-branch', async ($, on) => {
  const notGit = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
  const commands = { ...REPO, 'git rev-parse --show-toplevel': notGit, 'git branch --show-current': notGit }
  const { writes, clock } = world(on, { commands, forks: [DOC], cwd: '/work/plain' })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(writes['/work/plain/.claude/handoffs/2026-10-12-154500-no-branch.md']).toBe('# Handoff: demo\n\nbody\n')
})

test('a turn that starts while the fork runs gets the file but no status', async ($, on) => {
  const { writes, statuses, clock } = world(on, { commands: REPO, forks: [DOC], forkMs: 30_000 })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.advance(1_000)
  await $.turn.start({ text: 'back', turnId: 't2' })
  await clock.advance(30_000)
  await clock.settle()
  expect(writes[HANDOFF]).toBe('# Handoff: demo\n\nbody\n')
  expect(statuses).toEqual([undefined])
})

test('a fork from an earlier idle gap does not mark the later gap ready', async ($, on) => {
  const { forked, statuses, clock } = world(on, { commands: REPO, forks: [DOC, DOC], forkMs: 30_000 })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.advance(1_000)
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.advance(29_500)
  expect(statuses.filter((s) => s === READY).length).toBe(0)
  await clock.advance(30_000)
  await clock.settle()
  expect(forked.length).toBe(2)
  expect(statuses.slice(statuses.lastIndexOf(undefined) + 1)).toEqual([READY])
})

const RESUME = `Read ${HANDOFF}, check Preconditions, then continue from "Next steps".`
const clear = { reason: 'clear' as const, sessionId: 's1', resume: { id: 's1' } }

test('a /clear after a handoff fills the resume prompt 4 s later and clears the status', async ($, on) => {
  const { fills, statuses, state, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await $.session.end(clear)
  state.id = 's2'
  await clock.advance(3_999)
  expect(fills).toEqual([])
  await clock.advance(1)
  await clock.settle()
  expect(fills).toEqual([RESUME])
  expect(statuses).toEqual([undefined, READY, undefined])
})

test('a prompt sent within 4 s of the /clear is not followed by the resume prompt', async ($, on) => {
  const { fills, state, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await $.session.end(clear)
  state.id = 's2'
  await clock.advance(1_000)
  await $.turn.start({ text: 'new work', turnId: 't2' })
  await clock.advance(3_000)
  await clock.settle()
  expect(fills).toEqual([])
})

test('a /clear with no handoff fills nothing', async ($, on) => {
  const { fills, clock } = world(on, { commands: REPO })
  await idleTurn($)
  await $.session.end(clear)
  await clock.advance(5_000)
  await clock.settle()
  expect(fills).toEqual([])
})

test('text typed after the /clear is not replaced', async ($, on) => {
  const { fills, statuses, clock } = world(on, { commands: REPO, forks: [DOC], draft: 'my own prompt' })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await $.session.end(clear)
  await clock.advance(4_000)
  await clock.settle()
  expect(fills).toEqual([])
  expect(statuses).toEqual([undefined, READY, undefined])
})

test('a /clear after the user kept working fills nothing', async ($, on) => {
  const { fills, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await idleTurn($)
  await $.session.end(clear)
  await clock.advance(5_000)
  await clock.settle()
  expect(fills).toEqual([])
})

test('a /clear while the fork runs fills nothing, and the file is still written', async ($, on) => {
  const { fills, writes, statuses, state, clock } = world(on, { commands: REPO, forks: [DOC], forkMs: 30_000 })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.advance(1_000)
  await $.session.end(clear)
  await clock.advance(31_000)
  await clock.settle()
  expect(fills).toEqual([])
  expect(writes[HANDOFF]).toBe('# Handoff: demo\n\nbody\n')
  expect(statuses).toEqual([undefined])
  expect(state.store['handoff:s1']).toBeUndefined()
})

test('an exit with a ready handoff clears the status and fills nothing', async ($, on) => {
  const { fills, statuses, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(5_000)
  await clock.settle()
  expect(fills).toEqual([])
  expect(statuses).toEqual([undefined, READY, undefined])
})

const RECENT = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

test('a ready handoff is stored with its resume prompt', async ($, on) => {
  const { state, clock } = world(on, { commands: REPO, forks: [DOC] })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(state.store['handoff:s1']).toEqual({ resume: RESUME, at: 61_000 })
})

test('a /clear after a reload still fills the resume prompt and deletes the stored entry', async ($, on) => {
  const { fills, state, clock } = world(on, { store: { 'handoff:s1': { resume: RESUME, at: RECENT } } })
  await $.session.end(clear)
  state.id = 's2'
  await clock.advance(4_000)
  await clock.settle()
  expect(fills).toEqual([RESUME])
  expect(state.store['handoff:s1']).toBe(undefined)
})

test('the first prompt after a load deletes the stored handoff, so a later /clear fills nothing', async ($, on) => {
  const { fills, state, clock } = world(on, { store: { 'handoff:s1': { resume: RESUME, at: RECENT } } })
  await $.turn.start({ text: 'back', turnId: 't1' })
  expect(state.store['handoff:s1']).toBe(undefined)
  await $.turn.complete(turnEnd())
  await $.session.end(clear)
  await clock.advance(5_000)
  await clock.settle()
  expect(fills).toEqual([])
})

test('a session.end that is not a /clear deletes the stored handoff and fills nothing', async ($, on) => {
  const { fills, statuses, state, clock } = world(on, { store: { 'handoff:s1': { resume: RESUME, at: RECENT } } })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(5_000)
  await clock.settle()
  expect(state.store['handoff:s1']).toBe(undefined)
  expect(fills).toEqual([])
  expect(statuses).toEqual([undefined])
})

test('a new ready handoff prunes stored handoffs older than 7 days and keeps newer ones', async ($, on) => {
  const { state, clock } = world(on, {
    commands: REPO,
    forks: [DOC],
    store: {
      'handoff:old': { resume: 'x', at: 61_000 - 8 * DAY_MS },
      'handoff:new': { resume: 'y', at: 61_000 - 6 * DAY_MS },
      setup: { folders: [] },
    },
  })
  await idleTurn($)
  await $.session.compact(compacting())
  await clock.settle()
  expect(state.store['handoff:old']).toBe(undefined)
  expect(state.store['handoff:new']).toEqual({ resume: 'y', at: 61_000 - 6 * DAY_MS })
  expect(state.store.setup).toEqual({ folders: [] })
  expect(state.store['handoff:s1']).toBeDefined()
})

const LEAD = 360_000
const ARM = 1_000
const EXPIRES = 61_000 + HOUR
const FIRE = EXPIRES - LEAD
const TRANSCRIPT = '/home/u/.claude/projects/-work-my-demo/s1.jsonl'
const cache = (ttl: '1h' | '5m', expiresAt: number) => ({ exitCode: 0, stdout: JSON.stringify({ ttl, expiresAt }) })
const timed = (over: Partial<World> = {}): Partial<World> => ({
  commands: REPO,
  forks: [DOC, DOC],
  contextTokens: 103_224,
  cacheState: cache('1h', EXPIRES),
  ...over,
})

test('an idle turn over 50k tokens on a 1h cache writes a handoff 6 minutes before the cache expires', async ($, on) => {
  const { forked, writes, statuses, cacheRan, clock } = world(on, timed())
  await idleTurn($)
  await clock.advance(ARM)
  expect(cacheRan.map((r) => r.stdin)).toEqual([{ transcript: TRANSCRIPT }])
  await clock.set(FIRE - 1)
  expect(forked).toEqual([])
  await clock.set(FIRE)
  expect(forked.length).toBe(1)
  expect(writes[HANDOFF]).toBe(DOC.text)
  expect(statuses).toEqual([undefined, READY])
})

for (const [name, over] of [
  ['under 50k tokens', { contextTokens: 49_999 }],
  ['with no token count', { contextTokens: undefined }],
] as const) {
  test(`an idle turn ${name} runs no script and arms nothing`, async ($, on) => {
    const { forked, cacheRan, logged, clock } = world(on, timed(over))
    await idleTurn($)
    await clock.set(EXPIRES)
    expect(cacheRan).toEqual([])
    expect(forked).toEqual([])
    expect(logged).toEqual([])
  })
}

for (const [name, state] of [
  ['a 5m cache', cache('5m', 61_000 + 300_000)],
  ['an expiry already inside 6 minutes', cache('1h', 61_000 + LEAD)],
  ['a transcript with no main call', { exitCode: 0, stdout: '{}' }],
] as const) {
  test(`${name} arms nothing and logs nothing`, async ($, on) => {
    const { forked, cacheRan, logged, clock } = world(on, timed({ cacheState: state }))
    await idleTurn($)
    await clock.set(EXPIRES)
    expect(cacheRan.length).toBe(1)
    expect(forked).toEqual([])
    expect(logged).toEqual([])
  })
}

test('no transcript arms nothing and logs nothing', async ($, on) => {
  const { forked, cacheRan, logged, clock } = world(on, timed({ exists: () => false }))
  await idleTurn($)
  await clock.set(EXPIRES)
  expect(cacheRan).toEqual([])
  expect(forked).toEqual([])
  expect(logged).toEqual([])
})

for (const [name, state, reason] of [
  ['fails', { exitCode: 1, stdout: '', stderr: 'cache-state: boom\n' }, 'cache-state failed (exit 1): cache-state: boom'],
  ['prints invalid JSON', { exitCode: 0, stdout: 'nope' }, 'cache-state printed invalid JSON'],
] as const) {
  test(`a cache-state that ${name} arms nothing and logs the reason`, async ($, on) => {
    const { forked, logged, clock } = world(on, timed({ cacheState: state }))
    await idleTurn($)
    await clock.set(EXPIRES)
    expect(forked).toEqual([])
    expect(logged).toEqual([`handoff timer failed (${reason})`])
  })
}

test('turn.start cancels the timer, and the next idle turn arms it again', async ($, on) => {
  const later = EXPIRES + 10_000
  const { forked, cacheRan, state, clock } = world(on, timed())
  await idleTurn($)
  await clock.advance(ARM)
  state.cacheState = cache('1h', later)
  await $.turn.start({ text: 'more', turnId: 't2' })
  await clock.set(FIRE)
  expect(forked).toEqual([])
  await $.turn.complete(turnEnd({ turnId: 't2' }))
  await clock.advance(ARM)
  expect(cacheRan.length).toBe(2)
  await clock.set(later - LEAD)
  expect(forked.length).toBe(1)
})

test('turn.start during the arming delay runs no script', async ($, on) => {
  const { cacheRan, clock } = world(on, timed())
  await idleTurn($)
  await clock.advance(ARM - 1)
  await $.turn.start({ text: 'more', turnId: 't2' })
  await clock.advance(ARM)
  expect(cacheRan).toEqual([])
})

test('a cache-state reply that comes after turn.start arms nothing', async ($, on) => {
  const { forked, cacheRan, state, clock } = world(on, timed({ cacheMs: 2_000 }))
  await idleTurn($)
  await clock.advance(ARM)
  expect(cacheRan.length).toBe(1)
  await $.turn.start({ text: 'more', turnId: 't2' })
  // The second arming finds too few tokens, so it runs no script and sets no timer.
  state.contextTokens = 1_000
  await $.turn.complete(turnEnd({ turnId: 't2' }))
  await clock.advance(2_000)
  await clock.set(EXPIRES)
  expect(forked).toEqual([])
})

test('a /clear cancels the timer', async ($, on) => {
  const { forked, state, clock } = world(on, timed())
  await idleTurn($)
  await clock.advance(ARM)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  // forgetSession also drops the activity entry, which would stop a surviving timer at
  // fireHandoff's state check. turn.complete recreates a waiting entry. Its second
  // session.id call, in armHandoff, throws, so no arming replaces or cancels the timer.
  let idCalls = 0
  Object.defineProperty(state, 'id', {
    get() {
      if (++idCalls > 1) throw new Error('no id')
      return 's1'
    },
  })
  await $.turn.complete(turnEnd())
  await clock.set(EXPIRES)
  expect(forked).toEqual([])
})

test('the timer after an idle compaction in the same gap forks nothing more', async ($, on) => {
  const { forked, clock } = world(on, timed())
  await idleTurn($)
  await clock.advance(ARM)
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked.length).toBe(1)
  await clock.set(EXPIRES)
  expect(forked.length).toBe(1)
})

test('an idle compaction after the timer in the same gap forks nothing more', async ($, on) => {
  const { forked, clock } = world(on, timed())
  await idleTurn($)
  await clock.set(FIRE)
  expect(forked.length).toBe(1)
  await $.session.compact(compacting())
  await clock.settle()
  expect(forked.length).toBe(1)
})

// The plan limit band (register.ts).
const LIMITS = '/home/u/.claude/cc-dashboard/limit-warnings.json'
const BAND = {
  plugin: 'cc-dashboard',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}
// A window at `percent` that resets 2 h 10 min after the mock clock's start.
const at = (percent: number, kind: 'five_hour' | 'seven_day' = 'five_hour'): SessionRateLimit =>
  ({ kind, percentUsed: percent, resetsAt: new Date(61_000 + 130 * 60_000).toISOString() })
const bandLine = async (ui: { find: (q: { type?: string; text?: RegExp }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Text', text: /Nearing your plan limit/ }))?.text

test('a window at 75% shows the limit band and one at 74.4% does not', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(74.4), WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  await $.session.measure(measure([at(74.5), WEEK]))
  expect(await bandLine(ui)).toBe('⚠ Nearing your plan limit · Session 75% (resets in 2h 10m)')
  await ui.unmount()
})

test('Dismiss records the shown levels in limit-warnings.json and hides the band', async ($, on) => {
  const { writes } = world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), at(77, 'seven_day')]))
  expect(await bandLine(ui)).toBe('⚠ Nearing your plan limit · Session 81% (resets in 2h 10m) · Week 77% (resets in 2h 10m)')
  await ui.press({ key: 'dismiss-limits' })
  expect(JSON.parse(writes[LIMITS])).toEqual({ five_hour: 75, seven_day: 75 })
  expect(await bandLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('after a dismissal at 75 the band stays hidden at 80% and comes back at 90%', async ($, on) => {
  world(on, { files: { [LIMITS]: '{"five_hour":75,"seven_day":0}' } })
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(80), WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  await $.session.measure(measure([at(90), WEEK]))
  expect(await bandLine(ui)).toBe('⚠ Nearing your plan limit · Session 90% (resets in 2h 10m)')
  await ui.unmount()
})

test('a window below 75% sets its dismissed level back to 0', async ($, on) => {
  const { writes } = world(on, { files: { [LIMITS]: '{"five_hour":90,"seven_day":75}' } })
  await $.session.measure(measure([at(12), at(80, 'seven_day')]))
  expect(JSON.parse(writes[LIMITS])).toEqual({ five_hour: 0, seven_day: 75 })
})

test('a measure that changes no level writes no file', async ($, on) => {
  const { writes } = world(on)
  await $.session.measure(measure([at(23.5), WEEK]))
  expect(writes[LIMITS]).toBeUndefined()
})

test('a measure whose Session reading has already reset does not show the band', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 81, resetsAt: new Date(61_000 - 1).toISOString() }, WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('a measure with no plan windows leaves the band and the file alone', async ($, on) => {
  const { writes } = world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81)]))
  await $.session.measure(measure([{ kind: 'spend_limit', percentUsed: 99 }]))
  expect(await bandLine(ui)).toBe('⚠ Nearing your plan limit · Session 81% (resets in 2h 10m)')
  expect(writes[LIMITS]).toBeUndefined()
  await ui.unmount()
})

test('a dismissal another session wrote hides the band on the next measure', async ($, on) => {
  world(on, { files: { [LIMITS]: '{"five_hour":75,"seven_day":0}' } })
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('a dismissal another session wrote hides the band within a minute', async ($, on) => {
  const { state, clock } = world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), WEEK]))
  expect(await bandLine(ui)).toBeDefined()
  state.files[LIMITS] = '{"five_hour":75,"seven_day":0}'
  await clock.advance(60_000)
  expect(await bandLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('the recheck timer redraws the reset countdown', async ($, on) => {
  const { clock } = world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), WEEK]))
  await clock.advance(60_000)
  expect(await bandLine(ui)).toBe('⚠ Nearing your plan limit · Session 81% (resets in 2h 9m)')
  await ui.unmount()
})

test('an unreadable limit-warnings.json counts as no dismissal', async ($, on) => {
  world(on, { files: { [LIMITS]: 'not json' } })
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), WEEK]))
  expect(await bandLine(ui)).toBe('⚠ Nearing your plan limit · Session 81% (resets in 2h 10m)')
  await ui.unmount()
})

test('the band gives way to a survey', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  await $.session.measure(measure([at(81), WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  await ui.unmount()
})

test('a failed write on Dismiss still hides the band here and logs once', async ($, on) => {
  const { state, logged, clock, writes } = world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), WEEK]))
  state.writeFails = true
  await ui.press({ key: 'dismiss-limits' })
  expect(await bandLine(ui)).toBeUndefined()
  expect(logged.filter((line) => /limit band/.test(String(line)))).toHaveLength(1)
  await clock.advance(60_000)
  expect(await bandLine(ui)).toBeUndefined()
  await $.session.measure(measure([at(81), WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  state.writeFails = false
  await $.session.measure(measure([at(81), WEEK]))
  expect(JSON.parse(writes[LIMITS])).toEqual({ five_hour: 75, seven_day: 0 })
  await ui.unmount()
})

test('a failure in the band code does not stop record-statusline', async ($, on) => {
  const { ran } = world(on, { files: { [LIMITS]: '{"five_hour":90,"seven_day":0}' }, writeFails: true })
  await $.session.measure(measure([at(12), WEEK]))
  expect(ran.map((r) => r.argv[0])).toEqual(['/repo/bin/record-statusline'])
})

test('a session idle across a reset does not write its old dismissal over the reset', async ($, on) => {
  const { state, writes } = world(on, { files: { [LIMITS]: '{"five_hour":75,"seven_day":0}' } })
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(80), WEEK]))
  expect(await bandLine(ui)).toBeUndefined()
  state.files[LIMITS] = '{"five_hour":0,"seven_day":0}'
  await $.session.measure(measure([at(78), WEEK]))
  expect(writes[LIMITS]).toBeUndefined()
  expect(await bandLine(ui)).toContain('Session 78%')
  await ui.unmount()
})

test('a reading whose reset has passed leaves the band', async ($, on) => {
  const { clock } = world(on)
  const ui = await $.ui.mount(BAND)
  await $.session.measure(measure([at(81), WEEK]))
  expect(await bandLine(ui)).toBeDefined()
  await clock.advance(131 * 60_000)
  expect(await bandLine(ui)).toBeUndefined()
  await ui.unmount()
})
