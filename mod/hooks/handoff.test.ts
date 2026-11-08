import { test, expect } from 'claude-code/testing'
import { handoffText, handoffWaitMs, hourCacheExpiry, indexPath, resumePrompt } from './handoff'

const PATH = '/home/u/.claude/projects/-work-demo/s1.jsonl'

test('resumePrompt names the transcript and has no /transcript-handoff tip', async () => {
  const text = resumePrompt(PATH)
  expect(text).toContain(`Read ${PATH}, the transcript of an earlier Claude Code session`)
  expect(text).toContain('- The end shows where it stopped; the first user messages show the goal.')
  expect(text).not.toContain('/transcript-handoff')
})

test('handoffText starts a session in cwd, then gives the resume prompt and the /transcript-handoff tip', async () => {
  expect(handoffText('/work/demo', PATH)).toBe(
    `cd /work/demo && claude\n\n${resumePrompt(PATH)}\n- The last lines are the /transcript-handoff command that produced this prompt, so skip them.`,
  )
})

test('handoffText single-quotes a cwd with a space or a quote', async () => {
  expect(handoffText('/work/my demo', PATH).startsWith("cd '/work/my demo' && claude\n")).toBe(true)
  expect(handoffText("/work/it's", PATH).startsWith("cd '/work/it'\\''s' && claude\n")).toBe(true)
})

test('hourCacheExpiry gives the expiry of a 1h cache and null for anything else', async () => {
  expect(hourCacheExpiry({ ttl: '1h', expiresAt: 5 })).toBe(5)
  expect(hourCacheExpiry({ ttl: '5m', expiresAt: 5 })).toBe(null)
  expect(hourCacheExpiry({ ttl: '1h' })).toBe(null)
  expect(hourCacheExpiry({ ttl: '1h', expiresAt: '5' })).toBe(null)
})

test('handoffWaitMs is the time until leadMs before expiry, and 0 once that has passed', async () => {
  expect(handoffWaitMs(10_000, 1_000, 6_000)).toBe(3_000)
  expect(handoffWaitMs(10_000, 4_000, 6_000)).toBe(0)
  expect(handoffWaitMs(10_000, 5_000, 6_000)).toBe(0)
})

test('indexPath puts the index under cc-dashboard/transcript-index', async () => {
  expect(indexPath('/home/u/.claude', 's1')).toBe('/home/u/.claude/cc-dashboard/transcript-index/s1.md')
})

const INDEX = '/home/u/.claude/cc-dashboard/transcript-index/s1.md'

test('resumePrompt with an index tells the session to start with it', async () => {
  const text = resumePrompt(PATH, INDEX)
  expect(text).toContain(`Start with its index, ${INDEX}.`)
  expect(text).toContain('Then read only the line ranges you need.')
  expect(text.startsWith(`Read ${PATH}, the transcript of an earlier Claude Code session`)).toBe(true)
})

test('resumePrompt with no index is unchanged', async () => {
  expect(resumePrompt(PATH, undefined)).toBe(resumePrompt(PATH))
  expect(resumePrompt(PATH)).not.toContain('index')
})

test('handoffText passes the index to the resume prompt', async () => {
  expect(handoffText('/work/demo', PATH, INDEX)).toContain(resumePrompt(PATH, INDEX))
})
