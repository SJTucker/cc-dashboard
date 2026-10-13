'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/timeline.mjs');

test('timelineGutter is 22% of the panel, between 160 and 300px', async () => {
  const { timelineGutter } = await load();
  assert.equal(timelineGutter(1340), 295);
  assert.equal(timelineGutter(2000), 300);
  assert.equal(timelineGutter(600), 160);
});

test('timelineGutter never takes more than 40% of a narrow panel', async () => {
  const { timelineGutter } = await load();
  assert.equal(timelineGutter(300), 120);
});
