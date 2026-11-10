import { test, expect } from 'claude-code/testing'
import { backfillText, parseVerdicts, reviewOutcome, errorName, errorText, versionSpan } from './text'

test('errorName and errorText read an Error and fall back to "error" for anything else', async () => {
  expect(errorName(new TypeError('boom'))).toBe('TypeError')
  expect(errorText(new TypeError('boom'))).toBe('boom')
  expect(errorName('boom')).toBe('error')
  expect(errorText({ message: 'boom' })).toBe('error')
})

test('versionSpan shows a range for several versions, one version alone, and nothing for none', async () => {
  expect(versionSpan(['2.1.1', '2.1.2', '2.1.5'])).toBe('2.1.1–2.1.5')
  expect(versionSpan(['2.1.1'])).toBe('2.1.1')
  expect(versionSpan([])).toBe('')
})

test('backfillText reports nothing to judge, the counts, and the failures', async () => {
  expect(backfillText({ asked: 0, recorded: 0, relevant: 0, failed: [] })).toBe('No Claude Code version needs a verdict.')
  expect(backfillText({ asked: 3, recorded: 3, relevant: 1, failed: [] })).toBe('Judged 3 of 3 versions, 1 relevant.')
  expect(backfillText({ asked: 3, recorded: 2, relevant: 1, failed: ['a', 'b'] })).toBe(
    'Judged 2 of 3 versions, 1 relevant. Failed: a; b',
  )
  expect(backfillText({ asked: 0, recorded: 0, relevant: 0, failed: ['x'] })).toBe('Judged 0 of 0 versions, 0 relevant. Failed: x')
})

test('parseVerdicts reads a JSON object, treats a missing file as empty, and names the two failures', () => {
  expect(parseVerdicts(undefined)).toEqual({ verdicts: {} })
  expect(parseVerdicts('{"1.2.3":{}}')).toEqual({ verdicts: { '1.2.3': {} } })
  expect(parseVerdicts('')).toEqual({ error: 'not-json' })
  expect(parseVerdicts('[]')).toEqual({ error: 'not-object' })
  expect(parseVerdicts('null')).toEqual({ error: 'not-object' })
})

test('reviewOutcome returns the reply text, or the no-answer message with the api status', () => {
  expect(reviewOutcome({ isAnswered: true, text: 'ok' } as never)).toEqual({ reply: 'ok' })
  expect(reviewOutcome({ isAnswered: false, reason: 'api-error', status: 529 } as never)).toEqual({ error: 'Haiku gave no answer (api-error 529)' })
  expect(reviewOutcome({ isAnswered: false, reason: 'api-error', status: null } as never)).toEqual({ error: 'Haiku gave no answer (api-error)' })
  expect(reviewOutcome({ isAnswered: false, reason: 'timeout' } as never)).toEqual({ error: 'Haiku gave no answer (timeout)' })
})
