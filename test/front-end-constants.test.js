'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DETAIL_LIMIT } = require('../lib/rtk');
const { LIVE_WINDOW_MS } = require('../lib/sessions');
const { CLOSED_PAGE_SIZE } = require('../lib/review');

test('public/constants.mjs equals the server constants it mirrors', async () => {
  const front = await import('../public/constants.mjs');
  assert.equal(front.DETAIL_LIMIT, DETAIL_LIMIT);
  assert.equal(front.LIVE_WINDOW_MS, LIVE_WINDOW_MS);
  assert.equal(front.REVIEWS_CLOSED_PAGE, CLOSED_PAGE_SIZE);
});
