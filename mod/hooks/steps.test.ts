import { test, expect } from 'claude-code/testing'
import { parseSteps, stepOf, stepsText } from './steps'

const USAGE = { input_tokens: 2, output_tokens: 163, cache_read_input_tokens: 33650, cache_creation_input_tokens: 3649, model: 'claude-haiku-4-5' }

test('stepOf takes the counts and the answering model from the usage', async () => {
  expect(stepOf(USAGE, 1000, 't1', 2)).toEqual({ t: 1000, model: 'claude-haiku-4-5', input: 2, cacheWrite: 3649, cacheRead: 33650, output: 163, turnId: 't1', index: 2 })
})

test('stepsText and parseSteps round-trip the steps', async () => {
  const steps = [stepOf(USAGE, 1000, 't1', 0), stepOf({ ...USAGE, output_tokens: 5 }, 2000, 't1', 1)]
  expect(JSON.parse(stepsText('a1', steps))).toEqual({ agentId: 'a1', steps })
  expect(parseSteps(stepsText('a1', steps))).toEqual(steps)
})

test('parseSteps of a missing, empty or broken file is no steps', async () => {
  expect(parseSteps(undefined)).toEqual([])
  expect(parseSteps('')).toEqual([])
  expect(parseSteps('{"agentId":"a1","steps":[{"t":1')).toEqual([])
  expect(parseSteps('{"agentId":"a1"}')).toEqual([])
})

test('parseSteps drops a step with a bad count', async () => {
  const good = stepOf(USAGE, 1000, 't1', 0)
  const text = JSON.stringify({ agentId: 'a1', steps: [good, { ...good, output: 'x' }, { ...good, input: -1 }, null] })
  expect(parseSteps(text)).toEqual([good])
})
