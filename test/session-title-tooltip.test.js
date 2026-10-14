'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/sessions.mjs');

test('titleTooltip is the title, then a blank line and the recap when there is one', async () => {
  const { titleTooltip } = await load();
  assert.strictEqual(titleTooltip({ title: 'Fix it', recap: 'Goal was X.' }), 'Fix it\n\nGoal was X.');
  assert.strictEqual(titleTooltip({ title: 'Fix it', recap: null }), 'Fix it');
  assert.strictEqual(titleTooltip({ title: 'Fix it' }), 'Fix it');
});
