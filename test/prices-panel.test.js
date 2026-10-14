'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/prices.mjs');

function stubFetch(t, response) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => response;
  t.after(() => { globalThis.fetch = real; });
}

test('postJson returns the JSON body of the answer, including an error body', async (t) => {
  const { postJson } = await load();
  stubFetch(t, new Response(JSON.stringify({ error: 'The pricing page did not parse' }), { status: 422 }));
  assert.deepStrictEqual(await postJson('/api/prices/check'), { error: 'The pricing page did not parse' });
});

test('postJson returns { error: "HTTP <status>" } when the body is not JSON', async (t) => {
  const { postJson } = await load();
  stubFetch(t, new Response('<!DOCTYPE html><h1>Internal Server Error</h1>', { status: 500, headers: { 'Content-Type': 'text/html' } }));
  assert.deepStrictEqual(await postJson('/api/prices/check'), { error: 'HTTP 500' });
});
