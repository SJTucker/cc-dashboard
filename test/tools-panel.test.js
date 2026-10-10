'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { ERROR_CAUSES } = require('../lib/aggregate');

const load = () => import('../public/panels/tools.mjs');

const row = (calls, causes) => ({
  label: 'Opus 5.5',
  family: 'opus',
  calls,
  errors: Object.values(causes).reduce((a, b) => a + b, 0),
  errorCauses: Object.entries(causes).map(([cause, count]) => ({ cause, count })),
});

test('the panel cause names are causes lib/aggregate.js produces', async () => {
  const { MISTAKE_CAUSES, FAILED_CAUSES } = await load();
  const names = ERROR_CAUSES.map(([cause]) => cause);
  for (const cause of [...MISTAKE_CAUSES, ...FAILED_CAUSES]) assert.ok(names.includes(cause), cause);
});

test('modelErrorCells splits the errors into mistakes, failed commands and not counted', async () => {
  const { modelErrorCells } = await load();
  const cells = modelErrorCells(row(1000, { 'tool misused': 4, 'command failed': 20, 'blocked by a hook': 66, other: 3 }));

  assert.strictEqual(cells.mistakes, '0.4%');
  assert.strictEqual(cells.withFailed, '2.4%');
  assert.strictEqual(cells.notCounted, 69);
  assert.strictEqual(cells.notCountedTitle, 'blocked by a hook: 66\nother: 3');
  assert.strictEqual(cells.countsTitle, '4 misused and 20 failed commands in 1,000 calls');
});

test('modelErrorCells shows a dash for both rates below 20 calls', async () => {
  const { modelErrorCells, MIN_RATE_CALLS } = await load();
  assert.strictEqual(MIN_RATE_CALLS, 20);

  const few = modelErrorCells(row(19, { 'tool misused': 2 }));
  assert.strictEqual(few.mistakes, '–');
  assert.strictEqual(few.withFailed, '–');
  assert.strictEqual(few.countsTitle, '2 misused and 0 failed commands in 19 calls. Fewer than 20 calls, so no rate.');

  assert.strictEqual(modelErrorCells(row(20, { 'tool misused': 2 })).mistakes, '10.0%');
});

test('modelErrorCells with no errors shows 0.0% and an empty not-counted title', async () => {
  const { modelErrorCells } = await load();
  const cells = modelErrorCells(row(50, {}));
  assert.strictEqual(cells.mistakes, '0.0%');
  assert.strictEqual(cells.notCounted, 0);
  assert.strictEqual(cells.notCountedTitle, '');
});

const bash = { name: 'Bash', calls: 10, errors: 0, details: [], errorCauses: [], errorGroups: [], byModel: [] };
const read = { name: 'Read', calls: 5, errors: 0, details: [], errorCauses: [], errorGroups: [], byModel: [] };
const totals = { name: 'All tools', calls: 15, errors: 0, details: [], errorCauses: [], errorGroups: [], byModel: [] };

test('toolSelection keeps All tools selected while the range has tool calls', async () => {
  const { toolSelection, ALL_TOOLS } = await load();
  const pick = toolSelection([bash, read], totals, ALL_TOOLS);
  assert.strictEqual(pick.selected, ALL_TOOLS);
  assert.strictEqual(pick.current, totals);
  assert.strictEqual(pick.all, totals);
});

test('toolSelection falls back to the busiest tool when the selected one is gone', async () => {
  const { toolSelection } = await load();
  const pick = toolSelection([bash, read], totals, 'Grep');
  assert.strictEqual(pick.selected, 'Bash');
  assert.strictEqual(pick.current, bash);
});

test('toolSelection with no toolTotals, from a server older than the page, offers no All tools', async () => {
  const { toolSelection, ALL_TOOLS } = await load();
  const pick = toolSelection([bash, read], undefined, ALL_TOOLS);
  assert.strictEqual(pick.all, null);
  assert.strictEqual(pick.selected, 'Bash');
  assert.strictEqual(pick.current, bash);
});
