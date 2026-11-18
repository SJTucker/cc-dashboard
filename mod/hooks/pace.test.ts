import { test, expect } from 'claude-code/testing'
import { computePace, paceText, parsePaceCache, parseSessionProject } from './pace'
import type { PaceEntry } from './pace'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const MIN = 60_000

function near(actual: number | null | undefined, expected: number, tol: number) {
  expect(typeof actual === 'number' && Math.abs(actual - expected) < tol).toBe(true)
}

// Entries are percent@minute[/session], minutes relative to NOW.
function entries(spec: string[]): PaceEntry[] {
  return spec.map((s) => {
    const [pm, session] = s.split('/')
    const [percent, minute] = pm.split('@').map(Number)
    return { t: NOW + minute * MIN, percent, sessionId: session ?? null }
  })
}
function pace(spec: string[], resetsInMin: number) {
  return computePace(entries(spec), (NOW + resetsInMin * MIN) / 1000, NOW)
}

test('P1 one entry is idle', async () => {
  expect(pace(['20@-2'], 240)?.state).toBe('idle')
})
test('P2 no rise is idle', async () => {
  expect(pace(['10@-10', '10@-1'], 240)?.state).toBe('idle')
})
test('P3 a runaway session is fast', async () => {
  const p = pace(['20@-4/A', '22@-3/A', '24@-2/A', '26@-1/A', '28@0/A'], 240)!
  expect(p.state).toBe('fast')
  near(p.ratePerHour, 120, 1e-6)
  near(p.fastPerHour, 24, 1e-6)
  near(p.runsOutAt, NOW + 36 * MIN, 1e-6)
  expect(p.busySessionId).toBe('A')
})
test('P4 entries one minute apart are steady', async () => {
  expect(pace(['20@-1', '27@0'], 240)?.state).toBe('steady')
})
test('P5 the rate divides by now minus the oldest entry', async () => {
  const p = pace(['20@-14', '27@-13'], 240)!
  expect(p.state).toBe('steady')
  near(p.ratePerHour, 30, 1e-6)
})
test('P6 a rise of 5 is steady', async () => {
  expect(pace(['20@-5', '25@0'], 240)?.state).toBe('steady')
})
test('P7 entries older than 15 minutes leave the span', async () => {
  const p = pace(['10@-16', '20@-14', '21@0'], 240)!
  expect(p.state).toBe('steady')
  near(p.ratePerHour, 1 / (14 / 60), 1e-6)
})
test('P8 the margin shrinks to half the time left', async () => {
  const p = pace(['73@-6', '76@-3', '80@0'], 60)!
  expect(p.state).toBe('fast')
  near(p.fastPerHour, 40, 1e-6)
  near(p.ratePerHour, 70, 1e-6)
})
test('P9 a rate equal to the fast pace is steady', async () => {
  expect(pace(['74@-9', '80@0'], 60)?.state).toBe('steady')
})
test('P16 fast is allowed with exactly 45 minutes left', async () => {
  expect(pace(['73@-6', '76@-3', '80@0'], 45)?.state).toBe('fast')
})
test('P17 under 45 minutes left is never fast', async () => {
  const p = pace(['73@-6', '76@-3', '80@0'], 44)!
  expect(p.state).toBe('steady')
  near(p.ratePerHour, 70, 1e-6)
})
test('P10 a spent window is null', async () => {
  expect(pace(['100@-5', '100@0'], 60)).toBeNull()
})
test('P11 a passed reset is null', async () => {
  expect(pace(['20@-5', '30@0'], 0)).toBeNull()
})
test('P12 a tie for busiest session goes to the newest entry', async () => {
  expect(pace(['20@-6/A', '22@-5/B', '24@-4/A', '26@-3/B', '28@0'], 240)?.busySessionId).toBe('B')
})
test('P13 no session ids name no busy session', async () => {
  expect(pace(['20@-6', '28@0'], 240)?.busySessionId).toBeNull()
})
test('P13b empty session ids name no busy session', async () => {
  const list = entries(['20@-6', '28@0']).map((e) => ({ ...e, sessionId: '' }))
  expect(computePace(list, (NOW + 240 * MIN) / 1000, NOW)?.busySessionId).toBeNull()
})
test('P14 a burst 7 minutes ago is fast', async () => {
  const p = pace(['20@-11', '26@-7'], 244)!
  expect(p.state).toBe('fast')
  near(p.ratePerHour, 32.727, 0.005)
  near(p.fastPerHour, 24.13, 0.005)
})
test('P15 the same burst 4 minutes later has decayed to steady', async () => {
  const p = pace(['20@-15', '26@-11'], 240)!
  expect(p.state).toBe('steady')
  near(p.ratePerHour, 24, 1e-6)
  near(p.fastPerHour, 24.667, 0.005)
})
test('computePace returns null with no entries', async () => {
  expect(pace([], 240)).toBeNull()
})

const RESETS_AT = (NOW + 190 * MIN) / 1000
const FAST = {
  state: 'fast' as const, percent: 50, ratePerHour: 100, fastPerHour: 30,
  runsOutAt: NOW + 22 * MIN, busySessionId: 'A',
}

test('paceText names this session', async () => {
  expect(paceText(FAST, RESETS_AT, NOW, 'A', null))
    .toBe('⚠ 5h window: on pace to run out in 22m (resets in 3h 10m) · fastest: this session')
})
test('paceText names another session by project', async () => {
  expect(paceText({ ...FAST, busySessionId: 'B' }, RESETS_AT, NOW, 'A', 'cc-dashboard'))
    .toBe('⚠ 5h window: on pace to run out in 22m (resets in 3h 10m) · fastest: a session in cc-dashboard')
})
test('paceText omits the tail with no busy project', async () => {
  expect(paceText({ ...FAST, busySessionId: 'B' }, RESETS_AT, NOW, 'A', null))
    .toBe('⚠ 5h window: on pace to run out in 22m (resets in 3h 10m)')
})

test('parsePaceCache drops malformed entries', async () => {
  const text = JSON.stringify({
    fiveHourResetsAt: 1000,
    fiveHourRecent: [
      { t: 1, percent: 10, sessionId: 'A' },
      { t: 'x', percent: 10, sessionId: null },
      { t: 2, percent: null },
      null,
      { t: 3, percent: 12 },
    ],
  })
  expect(parsePaceCache(text)).toEqual({
    resetsAt: 1000,
    recent: [{ t: 1, percent: 10, sessionId: 'A' }, { t: 3, percent: 12, sessionId: null }],
  })
})
test('parsePaceCache returns null without fiveHourResetsAt', async () => {
  expect(parsePaceCache(JSON.stringify({ fiveHourRecent: [{ t: 1, percent: 1, sessionId: null }] }))).toBeNull()
  expect(parsePaceCache(undefined)).toBeNull()
  expect(parsePaceCache('not json')).toBeNull()
})

test('parseSessionProject reads project', async () => {
  expect(parseSessionProject(JSON.stringify({ sessionId: 'A', project: 'cc-dashboard' }))).toBe('cc-dashboard')
})
test('parseSessionProject returns null for bad JSON', async () => {
  expect(parseSessionProject('{')).toBeNull()
  expect(parseSessionProject(undefined)).toBeNull()
  expect(parseSessionProject(JSON.stringify({ project: 3 }))).toBeNull()
})

test('computePace leaves an entry stamped after now out of the span', async () => {
  const p = pace(['20@-5', '30@2'], 240)!
  expect(p.state).toBe('idle')
})

test('parsePaceCache returns null when the file and .claude.json name different accounts', async () => {
  const file = (account?: string) => JSON.stringify({ fiveHourResetsAt: 5, fiveHourRecent: [], accountUuid: account })
  const login = (account: string) => JSON.stringify({ oauthAccount: { accountUuid: account } })
  expect(parsePaceCache(file('A'), login('B'))).toBeNull()
  expect(parsePaceCache(file('A'), login('A'))).not.toBeNull()
  expect(parsePaceCache(file(), login('B'))).not.toBeNull()
  expect(parsePaceCache(file('A'), undefined)).not.toBeNull()
})
