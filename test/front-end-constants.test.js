'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DETAIL_LIMIT } = require('../lib/rtk');
const { LIVE_WINDOW_MS } = require('../lib/sessions');
const { KEEP_MS } = require('../lib/review');
const { DEFAULT_CACHE_READ_MULT } = require('../lib/pricing');

test('public/constants.mjs equals the server constants it mirrors', async () => {
  const front = await import('../public/constants.mjs');
  assert.equal(front.DETAIL_LIMIT, DETAIL_LIMIT);
  assert.equal(front.LIVE_WINDOW_MS, LIVE_WINDOW_MS);
  assert.equal(front.DEFAULT_CACHE_READ_MULT, DEFAULT_CACHE_READ_MULT);
  assert.equal(front.REVIEW_DAYS * 86_400_000, KEEP_MS);
});
