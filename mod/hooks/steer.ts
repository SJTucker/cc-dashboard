// Delivers the steers that the dashboard's Orchestration tab queues. The server writes
// <config dir>/cc-dashboard/steer/<session id>/<request id>.json, see writeSteerRequest
// in lib/orchestrations/controls.js. The relay sends each request's text to the worker
// and writes <request id>.result.json beside it. The result file marks the request
// answered, so $.fs needing no delete is enough.

export type SteerIo = {
  list: (dir: string) => Promise<string[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  send: (agentId: string, text: string) => Promise<{ isDelivered: boolean, reason?: string }>
  append: (text: string) => Promise<unknown>
  now: () => Promise<number>
}

// A request is a name that is exactly <id>.json, with the id characters of STEER_FILE
// in controls.js. The server's temp file <id>.json.<pid> and <id>.result.json are not
// requests.
const REQUEST_NAME = /^([A-Za-z0-9-]{1,64})\.json$/

// Request ids that have a request file, no result file, and are not in handled.
export function pendingRequests(names: string[], handled: Set<string>): string[] {
  const answered = new Set(names.flatMap((name) => /^(.+)\.result\.json$/.exec(name)?.[1] ?? []))
  const ids: string[] = []
  for (const name of names) {
    const id = REQUEST_NAME.exec(name)?.[1]
    if (id && !answered.has(id) && !handled.has(id)) ids.push(id)
  }
  return ids
}

export function steerNote(task: number | null, text: string): string {
  return `You steered ${task === null ? 'a worker' : `Task ${task}`} from the dashboard: ${text}`
}

function parseRequest(text: string): { agentId: string, task: number | null, text: string } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { agentId, task, text: steerText } = body as Record<string, unknown>
  if (typeof agentId !== 'string' || !agentId || typeof steerText !== 'string' || !steerText) return null
  return { agentId, task: typeof task === 'number' ? task : null, text: steerText }
}

// One pass over dir. An id joins handled before its first await, so a second pass
// that starts while this one is still sending skips it, and a request is sent once
// even when the result file cannot be written.
export async function relayOnce(io: SteerIo, dir: string, handled: Set<string>): Promise<void> {
  const names = await io.list(dir).catch(() => [] as string[])
  for (const id of pendingRequests(names, handled)) {
    handled.add(id)
    let delivered = false
    let reason: string | undefined
    try {
      const request = parseRequest(await io.read(`${dir}/${id}.json`))
      if (!request) {
        reason = 'the request file is not a valid steer'
      } else {
        const sent = await io.send(request.agentId, request.text)
        delivered = sent.isDelivered === true
        if (!delivered) reason = sent.reason ?? 'the worker did not accept the message'
        else await io.append(steerNote(request.task, request.text)).catch(() => undefined)
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    const result = { id, delivered, ...(reason === undefined ? {} : { reason }), at: await io.now() }
    await io.write(`${dir}/${id}.result.json`, JSON.stringify(result)).catch(() => undefined)
  }
}
