'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/guards.mjs');

test('createSequence: only the newest check stays true', async () => {
  const { createSequence } = await load();
  const loads = createSequence();
  const first = loads.next();
  assert.equal(first(), true);
  const second = loads.next();
  assert.equal(first(), false);
  assert.equal(second(), true);
});

test('createSequence: two sequences do not affect each other', async () => {
  const { createSequence } = await load();
  const a = createSequence();
  const b = createSequence();
  const checkA = a.next();
  b.next();
  assert.equal(checkA(), true);
});

test('createDrawGuard skips the same parts in the same minute', async () => {
  const { createDrawGuard } = await load();
  let t = 60_000 * 10 + 5_000;
  const guard = createDrawGuard({ now: () => t });
  let draws = 0;
  assert.equal(guard.draw({ a: 1 }, () => draws++), true);
  assert.equal(guard.draw({ a: 1 }, () => draws++), false);
  t += 30_000; // same minute
  assert.equal(guard.draw({ a: 1 }, () => draws++), false);
  assert.equal(draws, 1);
});

test('createDrawGuard draws again for new parts or a new minute', async () => {
  const { createDrawGuard } = await load();
  let t = 60_000 * 10;
  const guard = createDrawGuard({ now: () => t });
  let draws = 0;
  guard.draw([1], () => draws++);
  assert.equal(guard.draw([2], () => draws++), true);
  t += 60_000;
  assert.equal(guard.draw([2], () => draws++), true);
  assert.equal(draws, 3);
});

test('createDrawGuard keeps no key when the draw throws, so the next call draws', async () => {
  const { createDrawGuard } = await load();
  const guard = createDrawGuard({ now: () => 0 });
  assert.throws(() => guard.draw('x', () => { throw new Error('boom'); }), /boom/);
  let drew = false;
  assert.equal(guard.draw('x', () => { drew = true; }), true);
  assert.equal(drew, true);
});

test('createDrawGuard draws again after a throw, even for the parts drawn before it', async () => {
  const { createDrawGuard } = await load();
  const guard = createDrawGuard({ now: () => 0 });
  assert.equal(guard.draw('a', () => {}), true);
  assert.throws(() => guard.draw('b', () => { throw new Error('boom'); }), /boom/);
  let drew = false;
  assert.equal(guard.draw('a', () => { drew = true; }), true);
  assert.equal(drew, true);
});
