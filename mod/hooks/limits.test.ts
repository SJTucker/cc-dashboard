import { test, expect } from 'claude-code/testing'
import { NO_LEVELS, bandText, dismissLevels, levelOf, liveReadings, maxLevels, newerReadings, parseLevels, parseRateLimitsFile, withAccountLevels, claimsLegacy, UNKNOWN_ACCOUNT, parseUsageCache, readingsOf, resetLevels, resetText, sameLevels, shownWindows } from './limits'

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const IN_2H10 = '2026-10-12T14:10:00.000Z'
const IN_3D4H = '2026-10-15T16:00:00.000Z'

test('levelOf rounds the percent and returns the highest level reached', async () => {
  expect(levelOf(0)).toBe(0)
  expect(levelOf(74.4)).toBe(0)
  expect(levelOf(74.5)).toBe(75)
  expect(levelOf(89.4)).toBe(75)
  expect(levelOf(89.5)).toBe(90)
  expect(levelOf(100)).toBe(90)
})

test('readingsOf keeps the Session and Week windows in that order and drops the rest', async () => {
  expect(readingsOf([
    { kind: 'spend_limit', percentUsed: 99 },
    { kind: 'seven_day', percentUsed: 41, resetsAt: IN_3D4H },
    { kind: 'five_hour', percentUsed: 81 },
  ])).toEqual([
    { kind: 'five_hour', percent: 81 },
    { kind: 'seven_day', percent: 41, resetsAt: IN_3D4H },
  ])
  expect(readingsOf([])).toEqual([])
  expect(readingsOf([{ kind: 'five_hour', percentUsed: Number.NaN }])).toEqual([])
})

test('parseLevels reads 75 and 90 and counts anything else as 0', async () => {
  expect(parseLevels('{"five_hour":75,"seven_day":90}')).toEqual({ five_hour: 75, seven_day: 90 })
  expect(parseLevels('{"five_hour":80,"seven_day":"75"}')).toEqual(NO_LEVELS)
  expect(parseLevels('not json')).toEqual(NO_LEVELS)
  expect(parseLevels('null')).toEqual(NO_LEVELS)
  expect(parseLevels('"75"')).toEqual(NO_LEVELS)
  expect(parseLevels(undefined)).toEqual(NO_LEVELS)
})

test('resetLevels sets a window back to 0 once its reading is below the first level', async () => {
  const levels = { five_hour: 75, seven_day: 90 }
  expect(resetLevels([{ kind: 'five_hour', percent: 12 }], levels)).toEqual({ five_hour: 0, seven_day: 90 })
  expect(resetLevels([{ kind: 'five_hour', percent: 80 }, { kind: 'seven_day', percent: 91 }], levels)).toEqual(levels)
  expect(levels).toEqual({ five_hour: 75, seven_day: 90 })
})

test('shownWindows lists the windows whose level is above the dismissed level', async () => {
  const readings = [{ kind: 'five_hour' as const, percent: 81 }, { kind: 'seven_day' as const, percent: 90 }]
  expect(shownWindows(readings, NO_LEVELS)).toEqual(readings)
  expect(shownWindows(readings, { five_hour: 75, seven_day: 75 })).toEqual([readings[1]])
  expect(shownWindows(readings, { five_hour: 75, seven_day: 90 })).toEqual([])
})

test('dismissLevels raises each shown window to its current level and keeps the others', async () => {
  const shown = [{ kind: 'seven_day' as const, percent: 92 }]
  expect(dismissLevels(shown, { five_hour: 75, seven_day: 75 })).toEqual({ five_hour: 75, seven_day: 90 })
  expect(dismissLevels(shown, { five_hour: 0, seven_day: 90 })).toEqual({ five_hour: 0, seven_day: 90 })
})

test('sameLevels compares both windows', async () => {
  expect(sameLevels({ five_hour: 75, seven_day: 0 }, { five_hour: 75, seven_day: 0 })).toBe(true)
  expect(sameLevels({ five_hour: 75, seven_day: 0 }, { five_hour: 75, seven_day: 90 })).toBe(false)
})

test('resetText counts down in days and hours, hours and minutes, or minutes', async () => {
  expect(resetText(IN_2H10, NOW)).toBe('resets in 2h 10m')
  expect(resetText(IN_3D4H, NOW)).toBe('resets in 3d 4h')
  expect(resetText('2026-10-12T12:45:00.000Z', NOW)).toBe('resets in 45m')
  expect(resetText('2026-10-12T12:00:30.000Z', NOW)).toBe('resets in 1m')
  expect(resetText(undefined, NOW)).toBe('')
  expect(resetText('2026-10-12T11:00:00.000Z', NOW)).toBe('')
  expect(resetText('soon', NOW)).toBe('')
})

test('bandText names each shown window with its rounded percent and reset', async () => {
  expect(bandText([
    { kind: 'five_hour', percent: 81.4, resetsAt: IN_2H10 },
    { kind: 'seven_day', percent: 77, resetsAt: IN_3D4H },
  ], NOW)).toBe('⚠ Nearing your plan limit · Session 81% (resets in 2h 10m) · Week 77% (resets in 3d 4h)')
  expect(bandText([{ kind: 'seven_day', percent: 90 }], NOW)).toBe('⚠ Nearing your plan limit · Week 90%')
})

test('maxLevels keeps the higher level of each window', async () => {
  expect(maxLevels({ five_hour: 75, seven_day: 0 }, { five_hour: 0, seven_day: 90 })).toEqual({ five_hour: 75, seven_day: 90 })
})

test('liveReadings drops a past reset and keeps future, missing and unparseable ones', async () => {
  const past = { kind: 'five_hour' as const, percent: 80, resetsAt: new Date(NOW - 1).toISOString() }
  const future = { kind: 'seven_day' as const, percent: 80, resetsAt: new Date(NOW + 1).toISOString() }
  const missing = { kind: 'five_hour' as const, percent: 80 }
  const bad = { kind: 'seven_day' as const, percent: 80, resetsAt: 'soon' }
  expect(liveReadings([past, future, missing, bad], NOW)).toEqual([future, missing, bad])
})

test('parseRateLimitsFile reads both windows and turns resets_at seconds into ISO', async () => {
  const text = JSON.stringify({ fetchedAtMs: 5_000, rate_limits: {
    five_hour: { used_percentage: 87.5, resets_at: 1792968600 },
    seven_day: { used_percentage: 10 },
  }, dayStart: {} })
  expect(parseRateLimitsFile(text)).toEqual({ fetchedAtMs: 5_000, readings: [
    { kind: 'five_hour', percent: 87.5, resetsAt: new Date(1792968600 * 1000).toISOString() },
    { kind: 'seven_day', percent: 10 },
  ] })
  expect(parseRateLimitsFile(undefined)).toBeNull()
  expect(parseRateLimitsFile('not json')).toBeNull()
  expect(parseRateLimitsFile('{"rate_limits":{"five_hour":{"used_percentage":80}}}')).toBeNull()
  expect(parseRateLimitsFile('{"fetchedAtMs":1,"rate_limits":{"spend_limit":{"used_percentage":9}}}')).toBeNull()
})

test('parseRateLimitsFile ignores a file from another account than the logged-in one', async () => {
  const file = (accountUuid?: unknown) => JSON.stringify({ fetchedAtMs: 5_000, accountUuid, rate_limits: { five_hour: { used_percentage: 80 } } })
  const login = (uuid?: unknown) => JSON.stringify({ oauthAccount: { accountUuid: uuid } })
  expect(parseRateLimitsFile(file('A'), login('B'))).toBeNull()
  expect(parseRateLimitsFile(file('A'), login('A'))?.fetchedAtMs).toBe(5_000)
  expect(parseRateLimitsFile(file(), login('B'))?.fetchedAtMs).toBe(5_000)
  expect(parseRateLimitsFile(file('A'), login())?.fetchedAtMs).toBe(5_000)
  expect(parseRateLimitsFile(file('A'), 'not json')?.fetchedAtMs).toBe(5_000)
  expect(parseRateLimitsFile(file('A'))?.fetchedAtMs).toBe(5_000)
})

test('parseUsageCache ignores a cache from another account', async () => {
  const cache = { fetchedAtMs: 7_000, accountUuid: 'acct-1', utilization: { five_hour: { utilization: 80, resets_at: '2026-10-25T22:49:59Z' } } }
  expect(parseUsageCache(JSON.stringify({ oauthAccount: { accountUuid: 'acct-2' }, cachedUsageUtilization: cache }))).toBeNull()
  expect(parseUsageCache(JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' }, cachedUsageUtilization: cache }))?.fetchedAtMs).toBe(7_000)
})

test('parseUsageCache reads cachedUsageUtilization and keeps its ISO resets_at', async () => {
  const text = JSON.stringify({ other: 1, cachedUsageUtilization: { fetchedAtMs: 7_000, utilization: {
    five_hour: { utilization: 80, resets_at: '2026-10-25T22:49:59.768560+00:00' },
    seven_day: { utilization: 9, resets_at: '2026-11-01T09:59:59.768585+00:00' },
    seven_day_opus: null,
  } } })
  expect(parseUsageCache(text)).toEqual({ fetchedAtMs: 7_000, readings: [
    { kind: 'five_hour', percent: 80, resetsAt: '2026-10-25T22:49:59.768560+00:00' },
    { kind: 'seven_day', percent: 9, resetsAt: '2026-11-01T09:59:59.768585+00:00' },
  ] })
  expect(parseUsageCache('{"cachedUsageUtilization":null}')).toBeNull()
  expect(parseUsageCache('{"theme":"dark"}')).toBeNull()
  expect(parseUsageCache('{"cachedUsageUtilization":{"fetchedAtMs":1,"utilization":{"five_hour":{"utilization":"80"}}}}')).toBeNull()
  expect(parseUsageCache('{"truncat')).toBeNull()
  expect(parseUsageCache(undefined)).toBeNull()
})

test('newerReadings takes the newest snapshot newer than the band and ignores older ones', async () => {
  const band = [{ kind: 'five_hour' as const, percent: 77 }]
  const older = { fetchedAtMs: 900, readings: [{ kind: 'five_hour' as const, percent: 70 }] }
  const newer = { fetchedAtMs: 2_000, readings: [{ kind: 'five_hour' as const, percent: 85 }] }
  const newest = { fetchedAtMs: 3_000, readings: [{ kind: 'five_hour' as const, percent: 88 }] }
  expect(newerReadings(band, 1_000, [older, null])).toBeNull()
  expect(newerReadings(band, 1_000, [newer, newest, older])).toEqual({ fetchedAtMs: 3_000, readings: newest.readings })
  expect(newerReadings(band, 1_000, [{ fetchedAtMs: 5_000, readings: [] }])).toBeNull()
})

test('newerReadings replaces only the windows the newer snapshot has', async () => {
  const band = [{ kind: 'five_hour' as const, percent: 77 }, { kind: 'seven_day' as const, percent: 41 }]
  const sessionOnly = { fetchedAtMs: 2_000, readings: [{ kind: 'five_hour' as const, percent: 88 }] }
  expect(newerReadings(band, 1_000, [sessionOnly])).toEqual({ fetchedAtMs: 2_000, readings: [
    { kind: 'five_hour', percent: 88 },
    { kind: 'seven_day', percent: 41 },
  ] })
})

test('newerReadings takes each window from the newest snapshot that has it', async () => {
  const band = [{ kind: 'five_hour' as const, percent: 77 }, { kind: 'seven_day' as const, percent: 60 }]
  const cache = { fetchedAtMs: 2_000, readings: [{ kind: 'five_hour' as const, percent: 80 }, { kind: 'seven_day' as const, percent: 62 }] }
  const sessionOnly = { fetchedAtMs: 3_000, readings: [{ kind: 'five_hour' as const, percent: 88 }] }
  expect(newerReadings(band, 1_000, [sessionOnly, cache])).toEqual({ fetchedAtMs: 3_000, readings: [
    { kind: 'five_hour', percent: 88 },
    { kind: 'seven_day', percent: 62 },
  ] })
})

test('parseLevels keeps paceDismissed', async () => {
  expect(parseLevels('{"five_hour":75,"seven_day":0,"paceDismissed":1790866800}')).toEqual({ five_hour: 75, seven_day: 0, paceDismissed: 1790866800 })
  expect(parseLevels('{"paceDismissed":"x"}')).toEqual(NO_LEVELS)
})

test('sameLevels compares paceDismissed', async () => {
  const a = { five_hour: 0, seven_day: 0, paceDismissed: 5 }
  expect(sameLevels(a, { ...a })).toBe(true)
  expect(sameLevels(a, { five_hour: 0, seven_day: 0 })).toBe(false)
  expect(sameLevels(a, { ...a, paceDismissed: 6 })).toBe(false)
})

test('resetLevels and maxLevels keep paceDismissed', async () => {
  const levels = { five_hour: 90, seven_day: 0, paceDismissed: 5 }
  expect(resetLevels([{ kind: 'five_hour', percent: 10 }], levels)).toEqual({ five_hour: 0, seven_day: 0, paceDismissed: 5 })
  expect(maxLevels(levels, { five_hour: 0, seven_day: 75 })).toEqual({ five_hour: 90, seven_day: 75, paceDismissed: 5 })
  expect(maxLevels({ five_hour: 0, seven_day: 0, paceDismissed: 3 }, levels).paceDismissed).toBe(5)
})

test('parseLevels reads the entry of the given account', async () => {
  const text = JSON.stringify({ accounts: { A: { five_hour: 75, seven_day: 0 }, B: { five_hour: 90, seven_day: 75, paceDismissed: 7 } } })
  expect(parseLevels(text, 'A')).toEqual({ five_hour: 75, seven_day: 0 })
  expect(parseLevels(text, 'B')).toEqual({ five_hour: 90, seven_day: 75, paceDismissed: 7 })
  expect(parseLevels(text, 'C')).toEqual(NO_LEVELS)
  expect(parseLevels(text, null)).toEqual(NO_LEVELS)
})

test('parseLevels reads the unknown entry for a null account', async () => {
  const text = JSON.stringify({ accounts: { [UNKNOWN_ACCOUNT]: { five_hour: 90, seven_day: 0 } } })
  expect(parseLevels(text, null)).toEqual({ five_hour: 90, seven_day: 0 })
  expect(parseLevels(text, 'A')).toEqual(NO_LEVELS)
})

test('parseLevels reads an old flat file as the entry of any account', async () => {
  const flat = '{"five_hour":75,"seven_day":90,"paceDismissed":5}'
  expect(parseLevels(flat, 'A')).toEqual({ five_hour: 75, seven_day: 90, paceDismissed: 5 })
  expect(parseLevels(flat, 'B')).toEqual({ five_hour: 75, seven_day: 90, paceDismissed: 5 })
  expect(parseLevels(flat, null)).toEqual({ five_hour: 75, seven_day: 90, paceDismissed: 5 })
})

test('withAccountLevels replaces one entry and keeps the others', async () => {
  const text = JSON.stringify({ accounts: { A: { five_hour: 75, seven_day: 0, paceDismissed: 5 }, B: { five_hour: 0, seven_day: 90 } } })
  const out = JSON.parse(withAccountLevels(text, 'B', { five_hour: 90, seven_day: 90 }))
  expect(out).toEqual({ accounts: { A: { five_hour: 75, seven_day: 0, paceDismissed: 5 }, B: { five_hour: 90, seven_day: 90 } } })
  const added = JSON.parse(withAccountLevels(text, 'C', { five_hour: 75, seven_day: 0, paceDismissed: 9 }))
  expect(added.accounts.A).toEqual({ five_hour: 75, seven_day: 0, paceDismissed: 5 })
  expect(added.accounts.C).toEqual({ five_hour: 75, seven_day: 0, paceDismissed: 9 })
})

test('withAccountLevels writes the unknown key and converts an old flat file', async () => {
  expect(JSON.parse(withAccountLevels(undefined, null, { five_hour: 75, seven_day: 0 }))).toEqual({ accounts: { [UNKNOWN_ACCOUNT]: { five_hour: 75, seven_day: 0 } } })
  expect(JSON.parse(withAccountLevels('{"five_hour":75,"seven_day":0}', 'A', { five_hour: 90, seven_day: 0 }))).toEqual({ accounts: { A: { five_hour: 90, seven_day: 0 } } })
  expect(JSON.parse(withAccountLevels('not json', 'A', NO_LEVELS))).toEqual({ accounts: { A: NO_LEVELS } })
})

test('withAccountLevels keeps the flat levels of an old file as the legacy entry', async () => {
  const out = JSON.parse(withAccountLevels('{"five_hour":0,"seven_day":75,"paceDismissed":5}', null, { five_hour: 75, seven_day: 0 }))
  expect(out).toEqual({ accounts: { legacy: { five_hour: 0, seven_day: 75, paceDismissed: 5 }, [UNKNOWN_ACCOUNT]: { five_hour: 75, seven_day: 0 } } })
  const again = JSON.parse(withAccountLevels(JSON.stringify(out), null, NO_LEVELS))
  expect(again.accounts.legacy).toEqual({ five_hour: 0, seven_day: 75, paceDismissed: 5 })
})

test('an account without its own entry reads the legacy entry', async () => {
  const text = JSON.stringify({ accounts: { legacy: { five_hour: 0, seven_day: 75 }, A: { five_hour: 90, seven_day: 0 } } })
  expect(parseLevels(text, 'B')).toEqual({ five_hour: 0, seven_day: 75 })
  expect(parseLevels(text, null)).toEqual({ five_hour: 0, seven_day: 75 })
  expect(parseLevels(text, 'A')).toEqual({ five_hour: 90, seven_day: 0 })
})

test('a known account with no entry claims the legacy entry on its write', async () => {
  const text = JSON.stringify({ accounts: { legacy: { five_hour: 0, seven_day: 75 }, other: { five_hour: 90, seven_day: 0 } } })
  expect(claimsLegacy(text, 'A')).toBe(true)
  expect(claimsLegacy(text, 'other')).toBe(false)
  expect(claimsLegacy(text, null)).toBe(false)
  expect(claimsLegacy('{"five_hour":0,"seven_day":75}', 'A')).toBe(false)
  const out = JSON.parse(withAccountLevels(text, 'A', { five_hour: 0, seven_day: 75 }))
  expect(out).toEqual({ accounts: { A: { five_hour: 0, seven_day: 75 }, other: { five_hour: 90, seven_day: 0 } } })
  expect(parseLevels(JSON.stringify(out), 'B')).toEqual(NO_LEVELS)
})

test('a write to the unknown entry keeps the legacy entry', async () => {
  const text = JSON.stringify({ accounts: { legacy: { five_hour: 0, seven_day: 75 } } })
  expect(JSON.parse(withAccountLevels(text, null, { five_hour: 75, seven_day: 0 })).accounts.legacy).toEqual({ five_hour: 0, seven_day: 75 })
})

test('a known account that converts a flat file claims it, and the unknown account keeps legacy', async () => {
  const flat = '{"five_hour":75,"seven_day":0}'
  expect(claimsLegacy(flat, 'A')).toBe(false)
  const byA = JSON.parse(withAccountLevels(flat, 'A', { five_hour: 90, seven_day: 0 }))
  expect(byA).toEqual({ accounts: { A: { five_hour: 90, seven_day: 0 } } })
  expect(parseLevels(JSON.stringify(byA), 'B')).toEqual(NO_LEVELS)
  expect(JSON.parse(withAccountLevels(flat, null, NO_LEVELS)).accounts.legacy).toEqual({ five_hour: 75, seven_day: 0 })
})
