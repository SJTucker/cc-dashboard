import { test, expect } from 'claude-code/testing'
import { cleanLabel, commandPaths, fallbackLabel, includedPaths, lineDiff, settingsChanges, snapshotName } from './setup'

test('snapshotName is stable per path and differs between paths', async () => {
  expect(snapshotName('/h/.claude/CLAUDE.md')).toBe(snapshotName('/h/.claude/CLAUDE.md'))
  expect(snapshotName('/h/.claude/CLAUDE.md')).not.toBe(snapshotName('/w/p/CLAUDE.md'))
  expect(snapshotName('/h/.claude/CLAUDE.md')).toMatch(/^[0-9a-f]{8}-CLAUDE\.md\.json$/)
  expect(snapshotName('/h/Library/Application Support/rtk/config.toml')).toMatch(/^[0-9a-f]{8}-config\.toml\.json$/)
})

test('lineDiff lists added and removed lines, trimmed, without blanks', async () => {
  expect(lineDiff('a\n  b\n\nc', 'a\nc\n d \n\n')).toEqual({ added: ['d'], removed: ['b'] })
  expect(lineDiff('a\nb', 'b\na')).toEqual({ added: [], removed: [] })
})

test('fallbackLabel takes the first added line, then the first removed one', async () => {
  expect(fallbackLabel(['- Use cx for complexity'], ['old'])).toBe('Use cx for complexity')
  expect(fallbackLabel([], ['## Old rule'])).toBe('removed: Old rule')
  expect(fallbackLabel([], [])).toBe('changed')
  expect(fallbackLabel(['x'.repeat(80)], []).length).toBe(60)
})

test('cleanLabel keeps one short line and rejects the rest', async () => {
  expect(cleanLabel('  "don\'t commit docs."\n')).toBe("don't commit docs")
  expect(cleanLabel('first line\nsecond line')).toBe('first line')
  expect(cleanLabel('')).toBe(null)
  expect(cleanLabel('x'.repeat(61))).toBe(null)
})

test('settingsChanges splits a settings edit into one change per kind', async () => {
  const before = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
    model: 'opus[1m]',
    theme: 'dark',
  })
  const after = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'b' }] }], PreToolUse: [] },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } },
    model: 'sonnet',
    theme: 'light',
    skipWorkflowUsageWarning: true,
  })
  expect(settingsChanges(before, after)).toEqual([
    { kind: 'hook', label: 'hooks.Stop changed, hooks.PreToolUse added' },
    { kind: 'effort', label: 'modelSettings.claude-opus-5-5.effortLevel high → medium' },
    { kind: 'model', label: 'model opus[1m] → sonnet' },
    { kind: 'config', label: 'theme dark → light, skipWorkflowUsageWarning added' },
  ])
})

test('settingsChanges ignores plugin keys and names long or object values by path only', async () => {
  const before = JSON.stringify({ enabledPlugins: { a: true }, statusLine: { command: 'x' }, apiKeyHelper: 'short' })
  const after = JSON.stringify({ enabledPlugins: { a: false }, statusLine: { command: 'y' }, apiKeyHelper: 'x'.repeat(31) })
  expect(settingsChanges(before, after)).toEqual([
    { kind: 'config', label: 'statusLine.command x → y, apiKeyHelper changed' },
  ])
  expect(settingsChanges('{"permissions":{}}', '{}')).toEqual([{ kind: 'config', label: 'permissions removed' }])
})

test('settingsChanges never shows values under env or for apiKeyHelper', async () => {
  expect(settingsChanges('{"env":{"TOKEN":"abc"}}', '{"env":{"TOKEN":"xyz"}}')).toEqual([{ kind: 'config', label: 'env.TOKEN changed' }])
  expect(settingsChanges('{"apiKeyHelper":"a"}', '{"apiKeyHelper":"b"}')).toEqual([{ kind: 'config', label: 'apiKeyHelper changed' }])
})

test('settingsChanges ignores reordered keys', async () => {
  expect(settingsChanges('{"a":1,"b":{"c":1,"d":2}}', '{"b":{"d":2,"c":1},"a":1}')).toEqual([])
})

test('settingsChanges returns null when either side is not a JSON object', async () => {
  expect(settingsChanges('{', '{}')).toBe(null)
  expect(settingsChanges('{}', '[]')).toBe(null)
})

test('includedPaths reads @ lines relative to the file, with ~ expanded', async () => {
  const text = 'intro\n@RTK.md\n@~/notes/a.md\n@/abs/b.md\nnot @inline.md\n@RTK.md'
  expect(includedPaths(text, '/h/.claude', '/h')).toEqual(['/h/.claude/RTK.md', '/h/notes/a.md', '/abs/b.md'])
})

test('commandPaths takes the first word of each hook and the statusline when it is a path', async () => {
  const settings = JSON.stringify({
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: '~/code/x/bin/record-session-end' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'jq .' }, { type: 'command', command: '$HOME/bin/guard.sh --strict' }] }],
    },
    statusLine: { type: 'command', command: '/h/.claude/statusline.sh' },
  })
  expect(commandPaths(settings, '/h')).toEqual({
    hooks: ['/h/code/x/bin/record-session-end', '/h/bin/guard.sh'],
    statusline: '/h/.claude/statusline.sh',
  })
  expect(commandPaths('{', '/h')).toEqual({ hooks: [], statusline: null })
})
