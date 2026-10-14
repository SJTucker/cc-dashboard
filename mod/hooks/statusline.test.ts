import { test, expect } from 'claude-code/testing'
import { displayName, projectFolder, rateLimitsInput, statuslineRecord, toWindow } from './statusline'

test('displayName turns a model id into the statusline display name', async () => {
  expect(displayName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M context)')
  expect(displayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(displayName('claude-sonnet-5')).toBe('Sonnet 5')
  expect(displayName('some-gateway-model')).toBe('some-gateway-model')
})

test('toWindow converts an ISO reset time to epoch seconds and keeps a missing one out', async () => {
  expect(toWindow({ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-12T14:10:00.000Z' } as never)).toEqual({
    used_percentage: 40,
    resets_at: Date.parse('2026-10-12T14:10:00.000Z') / 1000,
  })
  expect(toWindow({ kind: 'five_hour', percentUsed: 40 } as never)).toEqual({ used_percentage: 40 })
  expect(toWindow({ kind: 'five_hour', percentUsed: 40, resetsAt: 'soon' } as never)).toEqual({ used_percentage: 40 })
})

test('rateLimitsInput keeps the two statusline windows and returns undefined for none', async () => {
  const five = { kind: 'five_hour', percentUsed: 10 }
  const seven = { kind: 'seven_day', percentUsed: 20 }
  const spend = { kind: 'spend_limit', percentUsed: 30 }
  expect(rateLimitsInput([five, seven, spend] as never)).toEqual({
    five_hour: { used_percentage: 10 },
    seven_day: { used_percentage: 20 },
  })
  expect(rateLimitsInput([spend] as never)).toBeUndefined()
  expect(rateLimitsInput([])).toBeUndefined()
})

test('statuslineRecord builds the required fields and adds the optional ones when present', async () => {
  const base = { id: 's1', launchId: 'L', transcript: '/t.jsonl', root: '/w/p', modelId: 'claude-haiku-4-5-20251001' }
  expect(statuslineRecord({ ...base, clearedFrom: undefined, cost: undefined, rateLimits: undefined })).toEqual({
    session_id: 's1',
    launch_id: 'L',
    transcript_path: '/t.jsonl',
    workspace: { project_dir: '/w/p' },
    model: { display_name: 'Haiku 4.5' },
  })
  const full = statuslineRecord({
    ...base,
    clearedFrom: 's0',
    cost: { usd: 1.5, startedAt: 1000, now: 4000 },
    rateLimits: { five_hour: { used_percentage: 10 } },
  })
  expect(full.cleared_from).toBe('s0')
  expect(full.cost).toEqual({ total_cost_usd: 1.5, total_duration_ms: 3000 })
  expect(full.rate_limits).toEqual({ five_hour: { used_percentage: 10 } })
})

test('statuslineRecord omits cleared_from for its own id and floors the duration at 0', async () => {
  const r = statuslineRecord({
    id: 's1', launchId: 'L', transcript: '/t', root: '/r', modelId: 'x',
    clearedFrom: 's1', cost: { usd: 0, startedAt: 5000, now: 1000 }, rateLimits: undefined,
  })
  expect('cleared_from' in r).toBe(false)
  expect(r.cost).toEqual({ total_cost_usd: 0, total_duration_ms: 0 })
})

test('projectFolder replaces every character outside a-z, A-Z and 0-9 with a dash', async () => {
  expect(projectFolder('/Users/bing/code/cc-dashboard.x')).toBe('-Users-bing-code-cc-dashboard-x')
})
