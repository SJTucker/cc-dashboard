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

const DIR = '/cfg/cc-dashboard/steer/s1'

function fake(files: Record<string, string>, send: SteerIo['send'], now = 99) {
  const calls: string[] = []
  const logs: string[] = []
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
    log: (text) => { logs.push(text) },
  }
  return { io, calls, files, logs }
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
