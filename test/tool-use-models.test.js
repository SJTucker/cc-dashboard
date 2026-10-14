'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toolUseModels } = require('../lib/tool-use-models');

// The nested-loop version from before the single-pointer rewrite, kept as the
// reference the new one must match.
function referenceToolUseModels(rows) {
  const calls = rows.calls.filter((c) => c.t != null).sort((a, b) => a.t - b.t);
  const models = new Map();
  for (const use of rows.toolUses) {
    let model = null;
    for (const c of calls) {
      if (c.t > use.t) break;
      model = c.model;
    }
    models.set(use.key, model);
  }
  return models;
}

// A small linear congruential generator, so the generated input is the same on every run.
function lcg(seed) {
  let s = seed;
  return (n) => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s % n;
  };
}

test('toolUseModels matches the nested-loop reference on generated input with ties, out-of-order tool uses and null t', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rand = lcg(seed);
    const calls = Array.from({ length: 1 + rand(40) }, (_, i) => ({ key: `c${i}`, t: rand(5) === 0 ? null : rand(30), model: `m${i}` }));
    const toolUses = Array.from({ length: rand(60) }, (_, i) => ({ key: `u${i}`, t: rand(35) }));
    const rows = { calls, toolUses };
    assert.deepStrictEqual([...toolUseModels(rows)], [...referenceToolUseModels(rows)], `seed ${seed}`);
  }
});

test('toolUseModels gives the later call in array order on a tie, and null before the first call', () => {
  const rows = {
    calls: [{ key: 'a', t: 20, model: 'm1' }, { key: 'b', t: 10, model: 'm2' }, { key: 'c', t: 20, model: 'm3' }, { key: 'd', t: null, model: 'm4' }],
    toolUses: [{ key: 'u1', t: 20 }, { key: 'u2', t: 9 }, { key: 'u3', t: 15 }],
  };
  assert.deepStrictEqual([...toolUseModels(rows)], [['u1', 'm3'], ['u2', null], ['u3', 'm2']]);
});
