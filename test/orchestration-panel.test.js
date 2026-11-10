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
