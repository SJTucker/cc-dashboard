'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/api.mjs');
const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('getJson resolves to the body of a 2xx answer', async () => {
  const { getJson } = await load();
  const seen = [];
  const body = await getJson('/api/x', { fetchImpl: async (url) => { seen.push(url); return answer(200, { a: 1 })(); } });
  assert.deepStrictEqual(body, { a: 1 });
  assert.deepStrictEqual(seen, ['/api/x']);
});

test('getJson turns an error body into { error, status }, preferring detail', async () => {
  const { getJson } = await load();
  assert.deepStrictEqual(await getJson('/x', { fetchImpl: answer(500, { error: 'scan failed', detail: 'EACCES' }) }), { error: 'EACCES', status: 500 });
  assert.deepStrictEqual(await getJson('/x', { fetchImpl: answer(500, { error: 'scan failed' }) }), { error: 'scan failed', status: 500 });
  assert.deepStrictEqual(await getJson('/x', { fetchImpl: answer(200, { error: 'busy' }) }), { error: 'busy', status: 200 });
});

test('getJson reports a non-JSON answer and a network failure without rejecting', async () => {
  const { getJson } = await load();
  const bad = await getJson('/x', { fetchImpl: answer(503, 'Service Unavailable') });
  assert.equal(bad.status, 503);
  assert.equal(typeof bad.error, 'string');
  const down = await getJson('/x', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepStrictEqual(down, { error: 'fetch failed', status: 0 });
});

test('getJson with optional resolves every failure to null', async () => {
  const { getJson } = await load();
  assert.deepStrictEqual(await getJson('/x', { optional: true, fetchImpl: answer(200, { a: 1 }) }), { a: 1 });
  assert.equal(await getJson('/x', { optional: true, fetchImpl: answer(500, { error: 'x' }) }), null);
  assert.equal(await getJson('/x', { optional: true, fetchImpl: answer(200, 'not json') }), null);
  assert.equal(await getJson('/x', { optional: true, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), null);
});

test('getJson calls the fetch that is global when it runs', async () => {
  const { getJson } = await load();
  const real = globalThis.fetch;
  globalThis.fetch = answer(200, { stubbed: true });
  try {
    assert.deepStrictEqual(await getJson('/x'), { stubbed: true });
  } finally {
    globalThis.fetch = real;
  }
});
