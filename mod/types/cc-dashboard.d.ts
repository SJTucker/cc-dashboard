// The $.state value the plan limit band keeps (hooks/register.ts). Reading and Levels
// match the types in hooks/limits.ts.
export type CcDashboardReading = { kind: 'five_hour' | 'seven_day'; percent: number; resetsAt?: string }
export type CcDashboardLevels = Record<'five_hour' | 'seven_day', number>

declare module 'claude-code' {
  interface PluginState {
    'cc-dashboard': { limitBand: { readings: CcDashboardReading[]; levels: CcDashboardLevels; unsaved: boolean } }
  }
}
