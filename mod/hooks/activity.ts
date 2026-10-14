// Pure helpers for the Live sessions activity state in register.ts. Nothing here
// takes $, and nothing reads the session maps that live in register.ts.

export type ToolRun = { name: string; detail: string; startedAt: number }
export type Activity = {
  sessionId: string
  state: 'working' | 'waiting'
  since: number
  tool: ToolRun | null
  subagents: number
  updatedAt: number
}

export const DETAIL_MAX = 60

// The running tools of one session in `all`, created empty on first use.
export function toolsOf(all: Map<string, Map<string, ToolRun>>, id: string) {
  let tools = all.get(id)
  if (!tools) {
    tools = new Map()
    all.set(id, tools)
  }
  return tools
}

export const newestTool = (tools: Map<string, ToolRun>) => [...tools.values()].pop() ?? null

// A new activity starts as working. Only a main-loop event creates one: turn.start,
// a main-loop tool.call, or turn.complete, which sets waiting at once. After a reload
// mid-turn, the first of these is a tool call, and the turn is running. Subagent
// events and agent.spawn create none, because the main loop may be waiting.
export function setState(a: Activity, state: Activity['state'], now: number) {
  if (a.state === state) return
  a.state = state
  a.since = now
}

// The command cut to DETAIL_MAX characters for Bash, the file's name for Read, Edit
// and Write, and nothing for any other tool. Whitespace runs become one space, so a
// multi-line command stays on one line.
export function toolDetail(tool: string, args: Record<string, unknown>) {
  if (tool === 'Bash') {
    return typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX) : ''
  }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    return typeof args.file_path === 'string' ? (args.file_path.split(/[\\/]/).pop() ?? '') : ''
  }
  return ''
}
