import { test, expect } from 'claude-code/testing'
import { pendingRequests, relayOnce, steerNote } from './steer'
import type { SteerIo } from './steer'

test('pendingRequests skips answered and handled requests', async () => {
  expect(pendingRequests(['a.json', 'a.result.json', 'b.json', 'c.json', 'x.tmp'], new Set(['c']))).toEqual(['b'])
})

test('pendingRequests never takes the server temp file name', async () => {
  expect(pendingRequests(['d.json.4321', 'e.json'], new Set())).toEqual(['e'])
})

test('steerNote names the task', async () => {
  expect(steerNote(5, 'Use resolveRoot')).toBe('You steered Task 5 from the dashboard: Use resolveRoot')
  expect(steerNote(null, 'Stop')).toBe('You steered a worker from the dashboard: Stop')
})

// lib/orchestrations/parse.js STEER_NOTE reads both forms back.
test('steerNote writes the exact strings the server parses', async () => {
  expect(steerNote(12, 'a\nb')).toBe('You steered Task 12 from the dashboard: a\nb')
  expect(steerNote(null, 'Stop now')).toBe('You steered a worker from the dashboard: Stop now')
})

const DIR = '/cfg/cc-dashboard/steer/s1'

function fake(files: Record<string, string>, send: SteerIo['send'], now = 99) {
  const calls: string[] = []
  const logs: string[] = []
  const cancelled: string[] = []
  const io: SteerIo = {
    list: async (dir) => {
      if (dir !== DIR) throw new Error('ENOENT')
      return Object.keys(files).map((path) => path.slice(DIR.length + 1))
    },
    read: async (path) => files[path] ?? Promise.reject(new Error('ENOENT')),
    write: async (path, text) => {
      calls.push(`write ${path.slice(DIR.length + 1)} ${text}`)
      files[path] = text
    },
    send: async (agentId, text) => {
      calls.push(`send ${agentId} ${text}`)
      return send(agentId, text)
    },
    append: async (text) => {
      calls.push(`append ${text}`)
    },
    now: async () => now,
    after: (_ms, _fn) => ({ cancel: () => { cancelled.push('timeout') } }),
    log: (text) => { logs.push(text) },
    ended: () => false,
  }
  return { io, calls, files, logs, cancelled }
}

const request = JSON.stringify({ id: 'b', agentId: 'a1', task: 5, text: 'Use resolveRoot', at: 1 })

test('relay sends, appends the note, and writes a delivered result', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }))
  await relayOnce(io, DIR, new Set())
  expect(calls).toEqual([
    'send a1 Use resolveRoot',
    'append You steered Task 5 from the dashboard: Use resolveRoot',
    'write b.result.json {"id":"b","delivered":true,"at":99}',
  ])
})

test('a pass makes no send after io.ended turns true, and leaves that request unanswered', async () => {
  const second = JSON.stringify({ id: 'c', agentId: 'a2', task: 6, text: 'Stop', at: 1 })
  let ended = false
  const { io, calls } = fake({ [`${DIR}/b.json`]: request, [`${DIR}/c.json`]: second }, async () => {
    ended = true
    return { isDelivered: true }
  })
  io.ended = () => ended
  await relayOnce(io, DIR, new Set())
  expect(calls).toEqual([
    'send a1 Use resolveRoot',
    'append You steered Task 5 from the dashboard: Use resolveRoot',
    'write b.result.json {"id":"b","delivered":true,"at":99}',
  ])
})

test('a refused send writes the reason and appends nothing', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: false, reason: 'no such agent' }))
  await relayOnce(io, DIR, new Set())
  expect(calls).toEqual([
    'send a1 Use resolveRoot',
    'write b.result.json {"id":"b","delivered":false,"reason":"no such agent","at":99}',
  ])
})

test('a send that throws writes delivered false with the error message', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: request }, async () => { throw new Error('engine refused') })
  await relayOnce(io, DIR, new Set())
  expect(calls[1]).toBe('write b.result.json {"id":"b","delivered":false,"reason":"engine refused","at":99}')
})

test('an unreadable request file is answered with delivered false and nothing is sent', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: '{oops' }, async () => ({ isDelivered: true }))
  await relayOnce(io, DIR, new Set())
  expect(calls).toEqual(['write b.result.json {"id":"b","delivered":false,"reason":"the request file is not a valid steer","at":99}'])
})

test('a handled id is not sent twice, and a missing folder lists nothing', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }))
  const handled = new Set(['b'])
  await relayOnce(io, DIR, handled)
  await relayOnce(io, '/nowhere', new Set())
  expect(calls).toEqual([])
})

test('a request older than 30 s is answered expired and is not sent or appended', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }), 30_002)
  await relayOnce(io, DIR, new Set())
  expect(calls).toEqual(['write b.result.json {"id":"b","delivered":false,"reason":"expired","at":30002}'])
})

test('a request exactly 30 s old is still sent', async () => {
  const { io, calls } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }), 30_001)
  await relayOnce(io, DIR, new Set())
  expect(calls[0]).toBe('send a1 Use resolveRoot')
})

test('a failed append and a failed result write are logged', async () => {
  const { io, logs } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }))
  io.append = async () => { throw new Error('append refused') }
  io.write = async () => { throw new Error('disk full') }
  await relayOnce(io, DIR, new Set())
  expect(logs).toEqual(['steer note not appended (append refused)', 'steer result b not written (disk full)'])
})

test('a send that never resolves is answered timed out after 10 s, logged, and the pass returns', async () => {
  const { io, calls, logs } = fake({ [`${DIR}/b.json`]: request }, () => new Promise(() => {}))
  const waits: number[] = []
  io.after = (ms, fn) => { waits.push(ms); fn(); return { cancel: () => {} } }
  await relayOnce(io, DIR, new Set())
  expect(waits).toEqual([10_000])
  // The send may still deliver later. Its result is ignored: the request is answered once,
  // and the owner may re-send.
  const reason = 'timed out (it may still arrive)'
  expect(calls).toEqual(['send a1 Use resolveRoot', `write b.result.json {"id":"b","delivered":false,"reason":"${reason}","at":99}`])
  expect(logs).toEqual([`steer b ${reason}`])
})

test('the timeout timer is cancelled when the send wins', async () => {
  const { io, cancelled } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }))
  await relayOnce(io, DIR, new Set())
  expect(cancelled).toEqual(['timeout'])
})

test('a send that resolves first is not reported as timed out', async () => {
  const { io, logs } = fake({ [`${DIR}/b.json`]: request }, async () => ({ isDelivered: true }))
  await relayOnce(io, DIR, new Set())
  expect(logs).toEqual([])
})

for (const at of [undefined, 'soon', null]) {
  test(`a request with at ${JSON.stringify(at) ?? 'missing'} is answered invalid request and not sent`, async () => {
    const body = JSON.stringify({ id: 'b', agentId: 'a1', task: 5, text: 'Use resolveRoot', ...(at === undefined ? {} : { at }) })
    const { io, calls } = fake({ [`${DIR}/b.json`]: body }, async () => ({ isDelivered: true }))
    await relayOnce(io, DIR, new Set())
    expect(calls).toEqual(['write b.result.json {"id":"b","delivered":false,"reason":"invalid request","at":99}'])
  })
}
