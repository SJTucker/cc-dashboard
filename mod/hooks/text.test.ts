import { test, expect } from 'claude-code/testing'
import { backfillText, errorName, errorText, versionSpan } from './text'

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
