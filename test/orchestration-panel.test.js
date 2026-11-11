'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/orchestration.mjs');

test('pickSelected keeps a listed saved id and falls back to the first', async () => {
  const { pickSelected } = await load();
  assert.equal(pickSelected([{ id: 'a' }, { id: 'b' }], 'b'), 'b');
  assert.equal(pickSelected([{ id: 'a' }], 'gone'), 'a');
  assert.equal(pickSelected([], 'gone'), null);
});

test('liveCount counts live orchestrations', async () => {
  const { liveCount } = await load();
  assert.equal(liveCount([{ live: true }, { live: false }, { live: true }]), 2);
  assert.equal(liveCount([]), 0);
});

test('the requests are optional and the detail id is URL-encoded', async () => {
  const { requestOrchestrations, requestOrchestration, ORCH_POLL_MS } = await load();
  assert.equal(ORCH_POLL_MS, 3000);
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: false, status: 404, json: async () => ({ error: 'x' }) }; };
  assert.equal(await requestOrchestrations({ fetchImpl }), null);
  assert.equal(await requestOrchestration('a b/c', { fetchImpl }), null);
  assert.deepEqual(seen, ['/api/orchestrations', '/api/orchestrations/a%20b%2Fc']);
});

test('sendBoardPost and sendSteer POST JSON to the id-encoded routes and never reject', async () => {
  const { sendBoardPost, sendSteer } = await load();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.method, init.headers['Content-Type'], JSON.parse(init.body)]);
    return { ok: true, status: 201, json: async () => ({ t: 'x' }) };
  };
  assert.deepEqual(await sendBoardPost('a b', { title: 'T', body: 'B' }, { fetchImpl }), { ok: true, status: 201, data: { t: 'x' } });
  await sendSteer('a b', { agentId: 'ag1', text: 'go' }, { fetchImpl });
  assert.deepEqual(seen, [
    ['/api/orchestrations/a%20b/board', 'POST', 'application/json', { title: 'T', body: 'B' }],
    ['/api/orchestrations/a%20b/steer', 'POST', 'application/json', { agentId: 'ag1', text: 'go' }],
  ]);
  const refused = async () => ({ ok: false, status: 409, json: async () => ({ error: 'no board yet' }) });
  assert.deepEqual(await sendBoardPost('a', { title: 'T' }, { fetchImpl: refused }), { ok: false, status: 409, data: { error: 'no board yet' } });
  const down = async () => { throw new Error('offline'); };
  assert.deepEqual(await sendSteer('a', { agentId: 'b', text: 'c' }, { fetchImpl: down }), { ok: false, status: 0, data: null });
});

// A localStorage stand-in that counts writes.
function fakeStorage() {
  const data = new Map();
  const writes = [];
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { writes.push([k, v]); data.set(k, String(v)); },
  };
  return { data, writes };
}

test('saveOrchestrationId writes only when the id changes', async () => {
  const { writes } = fakeStorage();
  const { saveOrchestrationId, savedOrchestrationId } = await load();
  saveOrchestrationId('one');
  saveOrchestrationId('one');
  saveOrchestrationId('one');
  assert.deepEqual(writes, [['cc-dashboard:orchestration', 'one']]);
  saveOrchestrationId('two');
  assert.equal(writes.length, 2);
  assert.equal(savedOrchestrationId(), 'two');
  saveOrchestrationId(null);
  assert.equal(writes.length, 2);
});

test('scheduleBoardSeen keeps one pending timer per orchestration and saves each own count', async (t) => {
  const { data } = fakeStorage();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { scheduleBoardSeen, boardSeen } = await load();
  scheduleBoardSeen('a', 3);
  scheduleBoardSeen('a', 4);
  scheduleBoardSeen('b', 7);
  t.mock.timers.tick(5999);
  assert.equal(boardSeen('a'), 0);
  t.mock.timers.tick(1);
  assert.equal(data.get('cc-dashboard:board-seen-others:a'), '3');
  assert.equal(data.get('cc-dashboard:board-seen-others:b'), '7');
  scheduleBoardSeen('a', 3);
  t.mock.timers.tick(6000);
  assert.equal(boardSeen('a'), 3);
});

// The gate with a scripted request and timer queue.
function gateHarness(answers, { hidden = false } = {}) {
  const calls = { request: 0, installed: [], removed: 0 };
  const queue = [];
  const timers = { setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, clearTimeout: () => {} };
  const env = { hidden };
  return { calls, queue, env, make: async () => {
    const { createOrchestrationGate } = await load();
    return createOrchestrationGate({
      request: async () => answers[Math.min(calls.request++, answers.length - 1)],
      onInstalled: (body) => calls.installed.push(body),
      onRemoved: () => { calls.removed++; },
      isHidden: () => env.hidden,
      timers,
    });
  } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('an installed:false answer makes one request, calls onRemoved and never retries', async () => {
  const h = gateHarness([{ installed: false }]);
  const gate = await h.make();
  await gate.start();
  assert.equal(h.calls.request, 1);
  assert.equal(h.calls.removed, 1);
  assert.equal(gate.installed, false);
  assert.equal(gate.settled, true);
  assert.equal(h.queue.length, 0);
  gate.resume();
  gate.accept({ installed: false });
  assert.equal(h.calls.request, 1);
  assert.equal(h.calls.removed, 1);
});

test('a null answer retries after 5 s, 15 s, 60 s, then every 5 min, until a real answer', async () => {
  const h = gateHarness([null, null, null, null, null, { installed: true, orchestrations: [] }]);
  const gate = await h.make();
  await gate.start();
  assert.equal(gate.settled, false);
  assert.equal(h.calls.removed, 0);
  const delays = [];
  while (h.queue.length) {
    const { fn, ms } = h.queue.shift();
    delays.push(ms);
    fn();
    await tick();
  }
  assert.deepEqual(delays, [5000, 15000, 60000, 300000, 300000]);
  assert.equal(h.calls.request, 6);
  assert.equal(gate.installed, true);
  assert.equal(h.calls.installed.length, 1);
});

test('a retry that comes due while the page is hidden waits for resume()', async () => {
  const h = gateHarness([null, { installed: true, orchestrations: [] }], { hidden: true });
  const gate = await h.make();
  await gate.start();
  h.queue.shift().fn();
  await tick();
  assert.equal(h.calls.request, 1);
  h.env.hidden = false;
  gate.resume();
  await tick();
  assert.equal(h.calls.request, 2);
  assert.equal(gate.installed, true);
});

test('a later installed:false removes the tab once, and a failed list answer does not', async () => {
  const h = gateHarness([{ installed: true, orchestrations: [] }]);
  const gate = await h.make();
  await gate.start();
  gate.accept(null);
  assert.equal(gate.installed, true);
  gate.accept({ installed: true, orchestrations: [] });
  assert.equal(gate.installed, true);
  gate.accept({ installed: false });
  gate.accept({ installed: false });
  assert.equal(gate.installed, false);
  assert.equal(h.calls.removed, 1);
});

test('syncOrchestrationPoller runs the poller only when installed, on the tab, on a shown page', async () => {
  const { syncOrchestrationPoller } = await load();
  const log = [];
  const poller = { start: () => log.push('start'), stop: () => log.push('stop') };
  const on = { installed: true, tab: 'orchestration', hidden: false };
  syncOrchestrationPoller(poller, on);
  syncOrchestrationPoller(poller, { ...on, hidden: true });
  syncOrchestrationPoller(poller, { ...on, tab: 'now' });
  syncOrchestrationPoller(poller, { ...on, tab: 'analysis' });
  assert.deepEqual(log, ['start', 'stop', 'stop', 'stop']);
});

test('syncOrchestrationPoller never starts the poller for a skill that is not installed', async () => {
  const { syncOrchestrationPoller } = await load();
  let starts = 0;
  const poller = { start: () => { starts++; }, stop() {} };
  for (const tab of ['now', 'analysis', 'orchestration', 'highscores']) {
    for (const hidden of [false, true]) syncOrchestrationPoller(poller, { installed: false, tab, hidden });
  }
  assert.equal(starts, 0);
});
