'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

installDom();
const load = () => import('../public/ui/show-all.mjs');

test('visibleRows keeps the first limit rows until expanded', async () => {
  const { visibleRows } = await load();
  const rows = [1, 2, 3, 4, 5, 6, 7];
  assert.deepStrictEqual(visibleRows(rows, 5, false), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(visibleRows(rows, 5, true), rows);
  assert.deepStrictEqual(visibleRows([1, 2], 5, false), [1, 2]);
});

test('visibleRows counts a group of rows once, so expanded children use no limit', async () => {
  const { visibleRows, showAllButton } = await load();
  // Each entry is one top-level row with its expanded child rows after it.
  const entries = [['g1', 'c1', 'c2', 'c3'], ['s2'], ['s3']];
  assert.deepStrictEqual(visibleRows(entries, 3, false).flat(), ['g1', 'c1', 'c2', 'c3', 's2', 's3']);
  assert.equal(showAllButton(entries.length, 3, false, () => {}), null);
});

test('showAllButton is null when the rows fit', async () => {
  const { showAllButton } = await load();
  assert.equal(showAllButton(5, 5, false, () => {}), null);
});

test('showAllButton names the total, and says Show fewer once expanded', async () => {
  const { showAllButton } = await load();
  const closed = showAllButton(43, 5, false, () => {});
  assert.equal(closed.textContent, 'Show all (43)');
  assert.equal(closed.getAttribute('aria-expanded'), 'false');
  const open = showAllButton(43, 5, true, () => {});
  assert.equal(open.textContent, 'Show fewer');
  assert.equal(open.getAttribute('aria-expanded'), 'true');
});
