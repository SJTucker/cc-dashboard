// The usage of each model request a subagent makes, as the mod records it for the
// dashboard. In interactive sessions on Claude Code 2.1.280 and later, most subagent
// responses never get their final usage line, so the transcript's output_tokens is
// the stream-start figure. The dashboard reads these files (lib/agent-steps.js) and
// uses the recorded output for a response whose transcript has no final line.

import type { TurnUsage } from 'claude-code'

export type AgentStep = {
  t: number
  model: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  // Which turn and which request in it, kept to diagnose a step that matches nothing.
  turnId: string
  index: number
}

export function stepOf(usage: TurnUsage, t: number, turnId: string, index: number): AgentStep {
  return {
    t,
    model: usage.model,
    input: usage.input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    output: usage.output_tokens,
    turnId,
    index,
  }
}

const isCount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0

function isStep(s: unknown): s is AgentStep {
  const x = s as Partial<AgentStep> | null
  return !!x && typeof x.model === 'string' && isCount(x.t) && isCount(x.input) && isCount(x.cacheWrite) && isCount(x.cacheRead) && isCount(x.output)
}

// The steps an agent's file already holds, or none when it is missing, empty or not
// a step file. A step with a bad count is dropped.
export function parseSteps(text: string | undefined): AgentStep[] {
  if (!text) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const steps = (data as { steps?: unknown } | null)?.steps
  return Array.isArray(steps) ? steps.filter(isStep) : []
}

export function stepsText(agentId: string, steps: readonly AgentStep[]): string {
  return JSON.stringify({ agentId, steps })
}
