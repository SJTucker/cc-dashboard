'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const token = (name) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];

// An SVG <pattern>'s paint cannot read a CSS custom property, so palette.mjs
// repeats these colours. This keeps the two copies equal.
test('palette TOKENS equal the custom properties in style.css', async () => {
  const { TOKENS } = await import('../public/charts/palette.mjs');
  const names = {
    surface: 'surface',
    textSecondary: 'text-secondary',
    accentCyan: 'accent-cyan',
    money: 'money',
    moneyFill: 'money-fill',
    seriesNeutral: 'series-neutral',
  };
  for (const [key, name] of Object.entries(names)) assert.equal(TOKENS[key], token(name), name);
});

test('amber is gone from the colour roles', () => {
  assert.doesNotMatch(css, /--accent-cost|--accent-dim/);
});

test('mythos is light slate with the cross texture', async () => {
  const { modelColor, modelTexture } = await import('../public/charts/palette.mjs');
  assert.equal(modelColor('mythos'), '#c9d1e0');
  assert.equal(modelTexture('mythos'), 'cross');
});

test('gridlines are solid', () => {
  const rule = css.match(/\.gridline\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /dasharray/);
});

test('split bar rows are ordered by size, so the larger part gets the solid style', async () => {
  const { sortSplitRows } = await import('../public/charts/split.mjs');
  const rows = [{ name: 'small', cost: 1 }, { name: 'big', cost: 9 }];
  assert.deepEqual(sortSplitRows(rows).map((r) => r.name), ['big', 'small']);
  assert.equal(rows[0].name, 'small');
});
