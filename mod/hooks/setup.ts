// Pure helpers for the setup change check in register.ts. Nothing here takes $.

export type Kind = 'claude-md' | 'skill' | 'hook' | 'rtk' | 'config' | 'effort' | 'model'
export type SetupEntry = { t: number; kind: Kind; name: string; label: string; file: string }
// text is null for a file that was removed after it was seen.
export type Snapshot = { path: string; mtimeMs: number; text: string | null }

export const LABEL_MAX = 60
const VALUE_MAX = 30
// Plugin installs get their markers from installed_plugins.json.
const IGNORED_KEYS = new Set(['enabledPlugins', 'extraKnownMarketplaces'])

// FNV-1a, 32 bits, as 8 hex digits, then the file's own name so a person can find
// it. The snapshot stores its path too, so a collision reads as no snapshot.
export function snapshotName(path: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const base = path.split('/').filter(Boolean).pop() ?? 'file'
  return `${h.toString(16).padStart(8, '0')}-${base.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

// Lines in one text and not the other, trimmed, blank lines left out, in order.
// A set difference: a moved line counts as neither added nor removed.
export function lineDiff(before: string, after: string) {
  const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)
  const old = lines(before)
  const now = lines(after)
  const oldSet = new Set(old)
  const nowSet = new Set(now)
  return { added: now.filter((line) => !oldSet.has(line)), removed: old.filter((line) => !nowSet.has(line)) }
}

const clip = (text: string) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text)
// Drops a Markdown list, heading or quote marker from the start of a line.
const bare = (line: string) => line.replace(/^[-*#>\s]+/, '').trim()

// The label when Haiku gives none.
export function fallbackLabel(added: string[], removed: string[]) {
  const first = added.map(bare).find(Boolean)
  if (first) return clip(first)
  const gone = removed.map(bare).find(Boolean)
  return gone ? clip(`removed: ${gone}`) : 'changed'
}

// The first line of Haiku's reply without quotes or a final full stop, or null when
// that line is empty or longer than LABEL_MAX.
export function cleanLabel(reply: string) {
  const line = (reply.trim().split('\n')[0] ?? '').trim().replace(/^["'`]+/, '').replace(/["'`.]+$/, '').trim()
  return line && line.length <= LABEL_MAX ? line : null
}

type Leaf = { path: string; before: unknown; after: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Sorted keys, so a file Claude Code rewrote in another key order compares equal.
const stable = (v: unknown): string =>
  isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'undefined'

// Collects the changed paths below `path`, descending `depth` levels of objects.
function leaves(before: unknown, after: unknown, path: string, depth: number, out: Leaf[]) {
  if (stable(before) === stable(after)) return
  if (depth > 0 && isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      leaves(before[key], after[key], `${path}.${key}`, depth - 1, out)
    }
    return
  }
  out.push({ path, before, after })
}

function settingKind(path: string): Kind {
  if (path === 'hooks' || path.startsWith('hooks.')) return 'hook'
  if (path === 'effortLevel' || /^modelSettings\..+\.effortLevel$/.test(path)) return 'effort'
  if (path === 'model') return 'model'
  return 'config'
}

const shown = (v: unknown) =>
  (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && String(v).length <= VALUE_MAX ? String(v) : null

function leafLabel({ path, before, after }: Leaf) {
  if (before === undefined) return `${path} added`
  if (after === undefined) return `${path} removed`
  const b = shown(before)
  const a = shown(after)
  return b !== null && a !== null ? `${path} ${b} → ${a}` : `${path} changed`
}

// One change per kind, each label listing that kind's changed key paths. Hooks are
// named per event (hooks.PreToolUse), not per command. Null when either side is not
// a JSON object.
export function settingsChanges(beforeText: string, afterText: string): Array<{ kind: Kind; label: string }> | null {
  let before: unknown
  let after: unknown
  try {
    before = JSON.parse(beforeText)
    after = JSON.parse(afterText)
  } catch {
    return null
  }
  if (!isObject(before) || !isObject(after)) return null
  const found: Leaf[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED_KEYS.has(key)) continue
    leaves(before[key], after[key], key, key === 'hooks' ? 1 : 8, found)
  }
  const byKind = new Map<Kind, string[]>()
  for (const leaf of found) {
    const kind = settingKind(leaf.path)
    byKind.set(kind, [...(byKind.get(kind) ?? []), leafLabel(leaf)])
  }
  return [...byKind].map(([kind, labels]) => ({ kind, label: labels.join(', ') }))
}

const expandHome = (p: string, home: string) => p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home)

// Files a CLAUDE.md pulls in with a line of its own, `@path`. A relative path is
// relative to the CLAUDE.md's folder (`base`).
export function includedPaths(text: string, base: string, home: string) {
  const paths: string[] = []
  for (const line of text.split('\n')) {
    const match = /^@(\S+)\s*$/.exec(line.trim())
    if (!match?.[1]) continue
    const raw = expandHome(match[1], home)
    const full = raw.startsWith('/') ? raw : `${base}/${raw.replace(/^\.\//, '')}`
    if (!paths.includes(full)) paths.push(full)
  }
  return paths
}

// The script each hook command and the statusline command run, when the command's
// first word is an absolute path once ~ and $HOME are expanded. A command such as
// `jq .` names no file of the setup.
export function commandPaths(settingsText: string, home: string) {
  const out = { hooks: [] as string[], statusline: null as string | null }
  let settings: unknown
  try {
    settings = JSON.parse(settingsText)
  } catch {
    return out
  }
  if (!isObject(settings)) return out
  const scriptOf = (command: unknown) => {
    if (typeof command !== 'string') return null
    const first = expandHome(command.trim().split(/\s+/)[0] ?? '', home)
    return first.startsWith('/') ? first : null
  }
  const hooks = isObject(settings.hooks) ? settings.hooks : {}
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const list = isObject(group) && Array.isArray(group.hooks) ? group.hooks : []
      for (const hook of list) {
        const script = isObject(hook) ? scriptOf(hook.command) : null
        if (script && !out.hooks.includes(script)) out.hooks.push(script)
      }
    }
  }
  out.statusline = isObject(settings.statusLine) ? scriptOf(settings.statusLine.command) : null
  return out
}
