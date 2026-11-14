// Pure helpers for the mod's debug log (CC_DASHBOARD_DEBUG=1). The buffer and the
// flush live in register.ts, because `$` may only go to a function declared there.

export const DEBUG_MAX_LINES = 2000

// The debug log is on only for the exact value 1.
export function debugOn(value: string | undefined): boolean {
  return value === '1'
}

// One log line: the time as an ISO string, the event name, then the fields.
export function debugLine(t: number, event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ t: new Date(t).toISOString(), event, ...fields })
}

export function keepLast(lines: string[], max = DEBUG_MAX_LINES): string[] {
  return lines.length > max ? lines.slice(lines.length - max) : lines
}
