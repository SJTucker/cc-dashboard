'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/ui/hidden.mjs');

// A stand-in for a panel element: controlsPanel reads only `hidden` and
// hasAttribute('data-user-hidden').
const panel = (name, { hidden = false, userHidden = false } = {}) => ({
  name,
  hidden,
  hasAttribute: (attr) => attr === 'data-user-hidden' && userHidden,
});

test('controlsPanel picks the first panel when both show', async () => {
  const { controlsPanel } = await load();
  assert.strictEqual(controlsPanel([panel('a'), panel('b')]).name, 'a');
});

test('controlsPanel skips a panel its renderer hid', async () => {
  const { controlsPanel } = await load();
  assert.strictEqual(controlsPanel([panel('a', { hidden: true }), panel('b')]).name, 'b');
});

test('controlsPanel skips a panel the user hid', async () => {
  const { controlsPanel } = await load();
  assert.strictEqual(controlsPanel([panel('a', { userHidden: true }), panel('b')]).name, 'b');
});

test('controlsPanel falls back to the first panel when none shows', async () => {
  const { controlsPanel } = await load();
  const panels = [panel('a', { hidden: true }), panel('b', { userHidden: true })];
  assert.strictEqual(controlsPanel(panels).name, 'a');
});
