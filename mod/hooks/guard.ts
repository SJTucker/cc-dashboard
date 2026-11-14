// Refuses a claimed worker's file edit outside its worktree. Pure helpers: the
// tool.call handler in register.ts passes plain values, because `$` may only go
// to a function declared in the same file.

export const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

// Copies CLAIM_COMMAND in lib/orchestrations/claims.js, which a mod cannot require.
const CLAIM_COMMAND = /\borch-claim\s+(?:"[^"]+"|'[^']+'|\S+)\s+(?:work|review)\b/
const CLAIMED_LINE = /^CLAIMED \S+/m
// Copies WORKTREE in lib/orchestrations/parse.js, which a mod cannot require.
const WORKTREE = /^Your worktree is (\S+?);/m

export type Claim = { worktree: string; run: string; file: string }

// Captures the run folder, with or without quotes, after orch-claim.
const CLAIM_RUN = /\borch-claim\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:work|review)\b/
const CLAIMED_FILE = /^CLAIMED (\S+)/m

// The claim an orch-claim call returned (worktree, run folder, task file), or null
// when the command is not a claim or the result holds no claim.
export function claimedWorktree(command: string, text: string): Claim | null {
  if (!CLAIM_COMMAND.test(command) || !CLAIMED_LINE.test(text)) return null
  const worktree = WORKTREE.exec(text)?.[1]
  const m = CLAIM_RUN.exec(command)
  const run = m?.[1] ?? m?.[2] ?? m?.[3]
  const file = CLAIMED_FILE.exec(text)?.[1]
  return worktree && run && file ? { worktree, run, file } : null
}

// Reads the text of a claim file back into a claim. An empty, unparseable or
// incomplete file is no claim.
export function parseClaim(text: string | undefined): Claim | null {
  if (!text) return null
  try {
    const c = JSON.parse(text)
    if (typeof c?.worktree === 'string' && typeof c.run === 'string' && typeof c.file === 'string' && c.worktree && c.run && c.file) {
      return { worktree: c.worktree, run: c.run, file: c.file }
    }
  } catch {
    // an empty or half-written file
  }
  return null
}

function inside(path: string, root: string): boolean {
  const dir = root.endsWith('/') ? root : `${root}/`
  return path === root || path.startsWith(dir)
}

// The target path of an Edit, Write or NotebookEdit call when it lies outside the
// worktree and the temp roots. A path with a .. segment counts as outside.
export function outsideWrite(tool: string, args: Record<string, unknown>, worktree: string): string | null {
  const key = tool === 'Edit' || tool === 'Write' ? 'file_path' : tool === 'NotebookEdit' ? 'notebook_path' : null
  if (!key) return null
  const path = args[key]
  if (typeof path !== 'string' || path === '') return null
  if (path.split('/').includes('..')) return path
  if (inside(path, worktree)) return null
  if (TEMP_ROOTS.some((root) => path.startsWith(root))) return null
  return path
}

export function guardReason(path: string, worktree: string): string {
  return `This worker claimed the worktree ${worktree}, and ${path} is outside it. Edit the copy inside ${worktree}. Put scratch files in your scratchpad.`
}
