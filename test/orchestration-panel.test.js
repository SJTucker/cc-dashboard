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
