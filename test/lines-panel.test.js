'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/lines.mjs');
const day = (date, linesByRepo) => ({ date, linesByRepo });

test('repoLabels uses the folder name, parent/folder for a shared name, and No repo for unknown', async () => {
  const { repoLabels } = await load();
  const labels = repoLabels(['/u/code/app', '/u/work/app', '/u/code/site', 'unknown']);
  assert.deepStrictEqual([...labels.values()], ['code/app', 'work/app', 'site', 'No repo']);
});

test('repoSeries ranks repos by lines changed, styles the top 4 and folds the rest into Other', async () => {
  const { repoSeries } = await load();
  const { REPO_SERIES, REPO_OTHER } = await import('../public/charts/palette.mjs');
  const daily = [
    day('2026-10-14', { '/r/a': { added: 50, removed: 10 }, '/r/b': { added: 1, removed: 0 }, '/r/e': { added: 2, removed: 0 } }),
    day('2026-10-15', { '/r/c': { added: 30, removed: 0 }, '/r/d': { added: 20, removed: 5 }, unknown: { added: 3, removed: 0 } }),
  ];
  const series = repoSeries(daily);

  assert.deepStrictEqual(series.map((s) => s.label), ['a', 'c', 'd', 'No repo', 'Other']);
  assert.deepStrictEqual(series.map((s) => s.color), [...REPO_SERIES.map((s) => s.color), REPO_OTHER.color]);
  assert.deepStrictEqual(series[0].added, [50, 0]);
  assert.deepStrictEqual(series[0].removed, [10, 0]);
  const other = series.at(-1);
  assert.strictEqual(other.key, 'other');
  assert.deepStrictEqual(other.added, [3, 0]);
  assert.deepStrictEqual(other.members, ['e', 'b']);
  assert.deepStrictEqual([other.totalAdded, other.totalRemoved], [3, 0]);
});

test('repoSeries breaks a tie by repo path, and adds no Other when 4 or fewer repos changed', async () => {
  const { repoSeries } = await load();
  const series = repoSeries([day('2026-10-15', { '/r/b': { added: 1, removed: 0 }, '/r/a': { added: 1, removed: 0 } })]);
  assert.deepStrictEqual(series.map((s) => s.key), ['/r/a', '/r/b']);
});

test('repoSeries returns no series for a range with no edits or buckets without linesByRepo', async () => {
  const { repoSeries } = await load();
  assert.deepStrictEqual(repoSeries([]), []);
  assert.deepStrictEqual(repoSeries([{ date: '2026-10-15' }, day('2026-10-16', {})]), []);
});
