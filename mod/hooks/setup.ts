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

// Values under env.* and apiKeyHelper can be secrets, so their labels never show them.
const isSecretPath = (path: string) => path === 'apiKeyHelper' || path.startsWith('env.')

function leafLabel({ path, before, after }: Leaf) {
  if (before === undefined) return `${path} added`
  if (after === undefined) return `${path} removed`
  if (isSecretPath(path)) return `${path} changed`
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

// The script a hook or statusline command runs, when the command's first word is an
// absolute path once ~ and $HOME are expanded. Null for any other command.
function scriptOf(command: unknown, home: string) {
  if (typeof command !== 'string') return null
  const first = expandHome(command.trim().split(/\s+/)[0] ?? '', home)
  return first.startsWith('/') ? first : null
}

function groupScripts(group: unknown, home: string) {
  const list = isObject(group) && Array.isArray(group.hooks) ? group.hooks : []
  return list.map((hook) => (isObject(hook) ? scriptOf(hook.command, home) : null)).filter((script) => script !== null)
}

function hookScripts(hooks: unknown, home: string) {
  const groups = Object.values(isObject(hooks) ? hooks : {}).flatMap((g) => (Array.isArray(g) ? g : []))
  return [...new Set(groups.flatMap((group) => groupScripts(group, home)))]
}

// The script each hook command and the statusline command run. A command such as
// `jq .` names no file of the setup.
export function commandPaths(settingsText: string, home: string) {
  let settings: unknown
  try {
    settings = JSON.parse(settingsText)
  } catch {
    return { hooks: [] as string[], statusline: null as string | null }
  }
  if (!isObject(settings)) return { hooks: [] as string[], statusline: null as string | null }
  const statusline = isObject(settings.statusLine) ? scriptOf(settings.statusLine.command, home) : null
  return { hooks: hookScripts(settings.hooks, home), statusline }
}

// prose files get a Haiku label, settings files a key diff, scripts their name, rtk
// files their first added line.
export type Mode = 'prose' | 'settings' | 'script' | 'rtk'
// `folder` decides whether a file with no snapshot is new (its folder was checked
// before) or seen for the first time (no marker).
export type Watched = { path: string; kind: Kind; name: string; folder: string; mode: Mode }
// `checked` holds, per folder, the time of the last check that covered it.
export type SetupState = { folders: string[]; mtimes: Record<string, number | null>; checked: Record<string, number> }

export const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A file in skills/, agents/ or rules/, from its path. Used for the folder listings
// and for paths the index holds that a listing no longer returns, so a deleted
// skill folder is still checked and found removed.
export function folderFile(dir: string, path: string): Watched | null {
  const skill = new RegExp(`^${escapeRegExp(dir)}/skills/([^/]+)/SKILL\\.md$`).exec(path)
  if (skill?.[1]) return { path, kind: 'skill', name: `skill ${skill[1]}`, folder: `${dir}/skills`, mode: 'prose' }
  const agent = new RegExp(`^${escapeRegExp(dir)}/agents/([^/]+)\\.md$`).exec(path)
  if (agent?.[1]) return { path, kind: 'skill', name: `agent ${agent[1]}`, folder: `${dir}/agents`, mode: 'prose' }
  if (path.startsWith(`${dir}/rules/`) && path.endsWith('.md')) {
    return { path, kind: 'claude-md', name: `rules/${path.slice(dir.length + 7)}`, folder: `${dir}/rules`, mode: 'prose' }
  }
  return null
}

export function readSetupState(saved: unknown): SetupState {
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<SetupState>
  const folders = Array.isArray(s.folders) ? s.folders.filter((f): f is string => typeof f === 'string') : []
  // A copy: checkSetup changes it, and the stored value must change only through store.set.
  const mtimes = typeof s.mtimes === 'object' && s.mtimes !== null ? { ...s.mtimes } : {}
  const checked: Record<string, number> = {}
  if (typeof s.checked === 'object' && s.checked !== null) {
    for (const [k, v] of Object.entries(s.checked)) if (typeof v === 'number') checked[k] = v
  }
  return { folders, mtimes, checked }
}

// The text of a session's changes file: what an earlier run of the same session id
// wrote, when that is an array, then the new entries.
export function changesFileText(earlier: unknown, entries: SetupEntry[]) {
  const kept = Array.isArray(earlier) ? earlier : []
  return `${JSON.stringify([...kept, ...entries], null, 2)}\n`
}
