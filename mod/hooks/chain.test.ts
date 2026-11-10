import { test, expect } from 'claude-code/testing'
import { appendChain } from './chain'

test('appendChain runs work in order after the previous chain and reports an error without rejecting', async () => {
  const seen: number[] = []
  const errors: unknown[] = []
  const onError = (err: unknown) => { errors.push(err) }
  const slow = async () => { await new Promise((r) => setTimeout(r, 20)); seen.push(1) }
  const first = appendChain(undefined, slow, onError)
  const second = appendChain(first, async () => { seen.push(2) }, onError)
  await second
  expect(seen).toEqual([1, 2])
  const boom = new Error('boom')
  const third = appendChain(second, async () => { throw boom }, onError)
  const fourth = appendChain(third, async () => { seen.push(4) }, onError)
  await fourth
  expect(errors).toEqual([boom])
  expect(seen).toEqual([1, 2, 4])
})
