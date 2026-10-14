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

test('a row with no invocations field reads as 0 invocations and does not throw', async () => {
  const { usageValue } = await load();
  assert.strictEqual(usageValue({ name: 'tdd', cost: 1 }, 100), '0× · 1.0%');
});

// ---- Cache bar -------------------------------------------------------------
const { installDom } = require('./dom-stub');

function renderWith(cacheCost, tokens = {}) {
  installDom();
  const nodes = {};
  const base = globalThis.document.createElement;
  for (const id of ['attributionPanel', 'threadBars', 'contextBars', 'cacheBars', 'cacheHit', 'skillBars', 'subagentBars']) nodes[id] = base('div');
  globalThis.document.getElementById = (id) => nodes[id];
  return load().then(({ renderAttribution }) => {
    renderAttribution({
      summary: { totalCost: 10, ...tokens }, threads: { main: 1, subagent: 1 }, context: { over: 1, under: 1 },
      contextThreshold: 150000, skills: [], subagents: [], cacheCost,
    });
    return nodes;
  });
}

test('the Cache bar lists reads, writes, uncached input and output in that order with fixed fills, whichever is largest', async () => {
  for (const cc of [
    { cacheRead: 9, cacheWrite: 1, input: 1, output: 1, saved: 5 },
    { cacheRead: 1, cacheWrite: 1, input: 1, output: 9, saved: 5 },
  ]) {
    const { cacheBars } = await renderWith(cc);
    const [bar, legend] = cacheBars.children;
    assert.deepEqual([...legend.children].map((item) => item.children[1].textContent), ['Cache reads', 'Cache writes', 'Uncached input', 'Output']);
    const styles = bar.children.map((seg) => seg.getAttribute('style'));
    assert.match(styles[0], /background:\s*(#3fe0ff|rgb\(63, 224, 255\))\s*;?/i);
    assert.match(styles[1], /repeating-linear-gradient\(45deg/);
    assert.match(styles[2], /radial-gradient/);
    assert.match(styles[3], /linear-gradient/);
    assert.notEqual(styles[3], styles[1]);
  }
});

test('the Cache note gives hit and miss shares of input tokens, and is empty when the range has no input tokens', async () => {
  const tokens = { totalInput: 100, totalCacheCreate: 400, totalCacheRead: 1500, cacheEfficiency: 0.75 };
  assert.equal((await renderWith(undefined, tokens)).cacheHit.textContent, '75.0% hits, 25.0% misses by input tokens');
  assert.equal((await renderWith(undefined)).cacheHit.textContent, '');
});

test('the Cache note tooltip says what cache reads saved, and is empty when nothing was saved or cacheCost is missing', async () => {
  const text = 'Cache reads saved $5.00 against the full input rate';
  assert.equal((await renderWith({ cacheRead: 1, cacheWrite: 1, input: 1, output: 1, saved: 5 })).cacheHit.title, text);
  assert.equal((await renderWith({ cacheRead: 1, cacheWrite: 1, input: 1, output: 1, saved: 0 })).cacheHit.title, '');
  assert.equal((await renderWith(undefined)).cacheHit.title, '');
});
