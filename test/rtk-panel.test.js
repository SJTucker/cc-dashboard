'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/rtk.mjs');

test('commandRows keeps the DETAIL_LIMIT largest magnitudes, negative included, ordered keptOut descending', async () => {
  const { commandRows } = await load();
  const commands = [];
  for (let i = 1; i <= 12; i++) commands.push({ name: `c${i}`, keptOut: i * 10 });
  commands.push({ name: 'neg', keptOut: -500 });
  const out = commandRows(commands);
  assert.strictEqual(out.length, 12);
  assert.ok(out.some((c) => c.name === 'neg'));
  assert.ok(!out.some((c) => c.name === 'c1'), 'the smallest magnitude is dropped');
  assert.strictEqual(out[out.length - 1].name, 'neg');
  const kept = out.map((c) => c.keptOut);
  assert.deepStrictEqual(kept, [...kept].sort((a, b) => b - a));
});
