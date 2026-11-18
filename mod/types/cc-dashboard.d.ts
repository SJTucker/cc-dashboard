// The $.state value the plan limit band keeps (hooks/register.ts). Reading and Levels
// match the types in hooks/limits.ts.
export type CcDashboardReading = { kind: 'five_hour' | 'seven_day'; percent: number; resetsAt?: string }
export type CcDashboardLevels = Record<'five_hour' | 'seven_day', number> & { paceDismissed?: number }
export type CcDashboardPace = {
  state: 'idle' | 'steady' | 'fast'
  percent: number
  ratePerHour: number
  fastPerHour: number
  runsOutAt: number | null
  busySessionId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'cc-dashboard': { limitBand: { readings: CcDashboardReading[]; levels: CcDashboardLevels; unsaved: boolean; fetchedAtMs: number; pace?: CcDashboardPace | null; paceResetsAt?: number | null; busyProject?: string | null; account?: string | null } }
  }
}
