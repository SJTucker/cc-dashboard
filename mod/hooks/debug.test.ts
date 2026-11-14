import { test, expect } from 'claude-code/testing'
import { debugLine, debugOn, keepLast } from './debug'

test('debugOn is true only for the string 1', async () => {
  expect(debugOn('1')).toBe(true)
  for (const v of [undefined, '', '0', 'true']) expect(debugOn(v)).toBe(false)
})

test('keepLast keeps the last 2000 lines', async () => {
  const lines = Array.from({ length: 2001 }, (_, i) => String(i))
  const kept = keepLast(lines)
  expect(kept).toHaveLength(2000)
  expect(kept[0]).toBe('1')
  expect(kept[1999]).toBe('2000')
  expect(keepLast(['a', 'b'])).toEqual(['a', 'b'])
})

test('debugLine writes t as an ISO string, then the event and the fields', async () => {
  expect(debugLine(0, 'x', { a: 1 })).toBe('{"t":"1970-01-01T00:00:00.000Z","event":"x","a":1}')
})
