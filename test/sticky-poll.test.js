'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

test('loadStickyData requests today\'s summary and the plan limits', async () => {
  const { loadStickyData } = await import('../public/sticky-poll.mjs');
  const urls = [];
  const getJson = async (url) => { urls.push(url); return { summary: 1 }; };
  const requestLimits = async () => { urls.push('/api/limits'); return { limits: [] }; };
  const out = await loadStickyData({ getJson, requestLimits });
  assert.deepEqual(urls.sort(), ['/api/limits', '/api/summary?days=today']);
  assert.deepEqual(out, { summary: { summary: 1 }, limits: { limits: [] } });
});
