'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/attribution.mjs');

test('usageValue shows the invocations, then the share of total cost', async () => {
  const { usageValue } = await load();
  assert.strictEqual(usageValue({ name: 'tdd', cost: 4.3, invocations: 21 }, 100), '21× · 4.3%');
  assert.strictEqual(usageValue({ name: 'general-purpose', cost: 61.2, invocations: 1587 }, 100), '1,587× · 61.2%');
  assert.strictEqual(usageValue({ name: 'review', cost: 1, invocations: 0 }, 100), '0× · 1.0%');
  assert.strictEqual(usageValue({ name: 'tdd', cost: 0, invocations: 2 }, 0), '2× · 0.0%');
});

test('usageTooltip names the row, its cost and share, and how often it was invoked', async () => {
  const { usageTooltip } = await load();
  assert.strictEqual(
    usageTooltip({ name: 'a<b', cost: 4.3, invocations: 21 }, 100),
    '<b>a&lt;b</b><br>$4.30 &middot; 4.3% of total<br>Invoked 21 times in this range'
  );
  assert.match(usageTooltip({ name: 'x', cost: 1, invocations: 1 }, 100), /<br>Invoked once in this range$/);
  assert.match(usageTooltip({ name: 'x', cost: 1, invocations: 1200 }, 100), /<br>Invoked 1,200 times in this range$/);
  assert.match(usageTooltip({ name: 'x', cost: 1, invocations: 0 }, 100), /<br>Not invoked in this range$/);
});
