// The Lines of code panel: lines added and deleted per day, one line pair per repo.
import { REPO_SERIES, REPO_OTHER } from '../charts/palette.mjs';

const NO_REPO = 'unknown';

function segments(repo) {
  return repo.split(/[\\/]/).filter(Boolean);
}

// The label of each repo key: its folder name, parent/folder when two keys share a
// folder name, and No repo for edits whose repo is not known.
export function repoLabels(keys) {
  const last = (repo) => segments(repo).at(-1) ?? repo;
  const counts = new Map();
  for (const repo of keys) if (repo !== NO_REPO) counts.set(last(repo), (counts.get(last(repo)) || 0) + 1);
  return new Map(keys.map((repo) => {
    if (repo === NO_REPO) return [repo, 'No repo'];
    return [repo, counts.get(last(repo)) > 1 ? segments(repo).slice(-2).join('/') : last(repo)];
  }));
}

const sum = (values) => values.reduce((total, v) => total + v, 0);

// The series the chart draws: the `limit` repos with the most lines added plus
// removed over the range, largest first, ties by repo path. Every other repo is
// summed into one Other series. A range with no edits has no series.
export function repoSeries(daily, limit = REPO_SERIES.length) {
  const totals = new Map();
  for (const d of daily) {
    for (const [repo, v] of Object.entries(d.linesByRepo || {})) totals.set(repo, (totals.get(repo) || 0) + v.added + v.removed);
  }
  const ranked = [...totals].filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([repo]) => repo);
  const labels = repoLabels(ranked);
  const perDay = (repos, field) => daily.map((d) => sum(repos.map((repo) => d.linesByRepo?.[repo]?.[field] || 0)));
  const build = (key, repos, style, label, members) => {
    const added = perDay(repos, 'added');
    const removed = perDay(repos, 'removed');
    return { key, label, color: style.color, dash: style.dash, added, removed, totalAdded: sum(added), totalRemoved: sum(removed), members };
  };
  const series = ranked.slice(0, limit).map((repo, i) => build(repo, [repo], REPO_SERIES[i], labels.get(repo), []));
  const rest = ranked.slice(limit);
  if (rest.length) series.push(build('other', rest, REPO_OTHER, 'Other', rest.map((repo) => labels.get(repo))));
  return series;
}
