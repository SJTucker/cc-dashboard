import { test, expect } from 'claude-code/testing'
import { NO_LEVELS, bandText, dismissLevels, levelOf, parseLevels, readingsOf, resetLevels, resetText, sameLevels, shownWindows } from './limits'

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
