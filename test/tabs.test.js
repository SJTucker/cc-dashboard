'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/ui/tabs.mjs');

test('tabFromHash reads #now and #analysis', async () => {
  const { tabFromHash } = await load();
  assert.equal(tabFromHash('#analysis'), 'analysis');
  assert.equal(tabFromHash('#now'), 'now');
  assert.equal(tabFromHash('analysis'), 'analysis');
});

test('tabFromHash falls back to Now for an empty or unknown hash', async () => {
  const { tabFromHash } = await load();
  for (const hash of ['', '#', '#settings', '#Analysis', undefined, null]) assert.equal(tabFromHash(hash), 'now', String(hash));
});

test('rangeForTab: Now is always Today, Analysis keeps its own range', async () => {
  const { rangeForTab } = await load();
  assert.equal(rangeForTab('now', 30), 'today');
  assert.equal(rangeForTab('analysis', 30), 30);
  assert.equal(rangeForTab('analysis', 'all'), 'all');
});
