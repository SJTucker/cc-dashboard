'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'base.css'), 'utf8');
const token = (name) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];

// An SVG <pattern>'s paint cannot read a CSS custom property, so palette.mjs
// repeats these colours. This keeps the two copies equal.
test('palette TOKENS equal the custom properties in css/base.css', async () => {
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

// Every font-size is a token, except 0, which .first-load uses to hide the dash.
test('font sizes come from the type scale', () => {
  const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim());
  const loose = sizes.filter((v) => v !== '0' && !/^var\(--fs-(caption|body|prose|title|stat)\)$/.test(v));
  assert.deepStrictEqual(loose, []);
});

test('letter-spacing is the label token or 0', () => {
  const values = [...css.matchAll(/letter-spacing:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(values.filter((v) => !['var(--ls-label)', '0', 'inherit'].includes(v)), []);
});

test('media queries use the three breakpoints', () => {
  const widths = [...css.matchAll(/@media[^{]*?(max|min)-width:\s*(\d+)px/g)].map((m) => `${m[1]}-${m[2]}`);
  assert.deepStrictEqual(widths.filter((w) => !['max-480', 'max-720', 'min-721', 'max-900', 'min-901'].includes(w)), []);
});

// .ba-under lines the legend up with the plot, so its margin is the plot's left pad in px.
test('.ba-under margin-left equals PLOT_LEFT', async () => {
  const { PLOT_LEFT } = await import('../public/charts/setup-changes.mjs');
  const m = css.match(/\.ba-under\s*\{\s*margin-left:\s*([^;}]+?)\s*[;}]/);
  assert.strictEqual(m && m[1], `${PLOT_LEFT}px`);
});
