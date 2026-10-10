'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// bar.mjs imports axes.mjs, which reads the axisScale global that index.html sets.
globalThis.axisScale = require('../public/chart-geometry.js').axisScale;

test('barRect places positive bars above zeroY, negative bars below it, on a signed scale', async () => {
  const { barRect } = await import('../public/charts/bar.mjs');
  const { signedTicks } = await import('../public/charts/axes.mjs');
  const scale = signedTicks(-40, 100);

  const up = barRect(100, scale);
  assert.ok(up.y < scale.zeroY);
  assert.ok(Math.abs(up.y + up.height - scale.zeroY) < 1e-9, 'a positive bar ends at the zero line');

  const down = barRect(-40, scale);
  assert.strictEqual(down.y, scale.zeroY, 'a negative bar starts at the zero line');
  assert.ok(down.height > 0);
  assert.ok(Math.abs(down.y + down.height - scale.yOf(-40)) < 1e-9, 'and ends at its value');

  assert.strictEqual(barRect(0, scale).height, 0);

  const tiny = barRect(0.0001, scale);
  assert.strictEqual(tiny.height, 1);
  assert.strictEqual(barRect(-0.0001, scale).height, 1);
});
