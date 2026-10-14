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

test('timelineTooltip puts the escaped recap after the time range, only when there is one', async () => {
  const { timelineTooltip } = await load();
  const bar = { start: Date.parse('2026-01-01T10:00:00'), end: Date.parse('2026-01-01T10:00:00') };
  const base = { title: 'T', project: 'p', branch: 'b', costTodayUsd: 1, prompts: 2 };
  const withRecap = timelineTooltip({ ...base, recap: 'Goal <b>x</b>. Next: y.' }, bar);
  assert.match(withRecap, /<div class="tooltip-recap">Goal &lt;b&gt;x&lt;\/b&gt;\. Next: y\.<\/div>/);
  assert.ok(withRecap.indexOf('tooltip-recap') > withRecap.indexOf('prompt'));
  assert.ok(!timelineTooltip({ ...base, recap: null }, bar).includes('tooltip-recap'));
});
