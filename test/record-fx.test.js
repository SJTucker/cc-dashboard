'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let F;
let S;
before(async () => {
  F = await import('../public/fx/record-fx.mjs');
  S = await import('../public/fx/sprites.mjs');
});

test('fxMode shows text only under reduced motion or a narrow bar', () => {
  assert.equal(F.fxMode({ width: 1200, reducedMotion: false }), 'fight');
  assert.equal(F.fxMode({ width: 1200, reducedMotion: true }), 'text');
  assert.equal(F.fxMode({ width: 639, reducedMotion: false }), 'text');
  assert.equal(F.fxMode({ width: 640, reducedMotion: false }), 'fight');
});

test('pickAnimation splits 50/50', () => {
  assert.equal(F.pickAnimation(() => 0.49), 'fatality');
  assert.equal(F.pickAnimation(() => 0.5), 'headshot');
});

test('sprites use only palette colours', () => {
  for (const grid of [...Object.values(S.NINJA), ...Object.values(S.SOLDIER), S.RIFLE, S.CLAUDE]) {
    for (const ch of grid.join('')) assert.ok(ch === '.' || ch in S.PALETTE, ch);
  }
});

test('every sprite row in a frame has the same width', () => {
  for (const frames of [S.NINJA, S.SOLDIER]) {
    for (const [name, grid] of Object.entries(frames)) {
      assert.equal(new Set(grid.map((row) => row.length)).size, 1, name);
    }
  }
});

test('the burst palette is red', () => {
  assert.deepStrictEqual(S.BLOOD, ['#e01b24', '#b0101c', '#8a0a14', '#ff3a3a', '#6e0810']);
});

test('the fx files name no game or character', () => {
  for (const f of ['sprites.mjs', 'record-fx.mjs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'fx', f), 'utf8');
    assert.doesNotMatch(src, /mortal|kombat|sub-?zero|call of duty|fonts\.googleapis/i, f);
  }
});

test('playRecordFx falls back to text when the canvas has no 2d context', async () => {
  const made = [];
  const el = (tag) => {
    const e = {
      tag, children: [], style: {}, className: '', textContent: '',
      setAttribute() {},
      append(...c) { this.children.push(...c); made.push(...c); },
      appendChild(c) { this.children.push(c); made.push(c); return c; },
      remove() { this.removed = true; },
      getBoundingClientRect: () => ({ width: 1200, height: 76 }),
      getContext: () => null,
    };
    return e;
  };
  const savedDoc = global.document;
  const savedTimeout = global.setTimeout;
  const timers = [];
  global.document = { createElement: el };
  global.setTimeout = (fn, ms) => timers.push({ fn, ms });
  const bar = el('div');
  try {
    const p = F.playRecordFx(bar, [{ title: 'COST IN ONE DAY', score: '$1.00' }], { random: () => 0.1, reducedMotion: false });
    assert.strictEqual(F.playRecordFx(bar, [], {}), p);
    const overlay = made.find((e) => e.className.startsWith('record-fx'));
    assert.ok(overlay, 'overlay appended');
    assert.match(JSON.stringify(overlay.children.map((c) => c.textContent)), /NEW RECORD · COST IN ONE DAY · \$1\.00/);
    assert.equal(timers[0].ms, 4000);
    timers.shift().fn();
    await p;
    assert.ok(overlay.removed, 'overlay removed');
    const next = F.playRecordFx(bar, [{ title: 'A', score: '1' }], { reducedMotion: true });
    assert.notStrictEqual(next, p);
    timers.shift().fn();
    await next;
  } finally {
    global.document = savedDoc;
    global.setTimeout = savedTimeout;
  }
});

test('playRecordFx finishes when drawing throws, and a later call starts fresh', async () => {
  const ctx = new Proxy({}, { get: (_, k) => (k === 'fillRect' ? () => { throw new Error('boom'); } : () => {}), set: () => true });
  const el = () => ({
    style: {}, className: '', textContent: '', clientWidth: 1200, clientHeight: 76,
    setAttribute() {}, append() {}, remove() { this.removed = true; },
    querySelector: () => el(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 1200, height: 76 }),
    getContext: () => ctx,
  });
  const saved = [global.document, global.requestAnimationFrame];
  global.document = { createElement: el };
  const frames = [];
  global.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    const bar = el();
    const p = F.playRecordFx(bar, [{ title: 'A', score: '1' }], { random: () => 0.1, reducedMotion: false });
    frames.shift()(0);
    await p;
    const q = F.playRecordFx(bar, [{ title: 'A', score: '1' }], { random: () => 0.1, reducedMotion: false });
    assert.notStrictEqual(q, p);
    frames.shift()(0);
    await q;
  } finally {
    [global.document, global.requestAnimationFrame] = saved;
  }
});
