// The Setup changes panels: context at session start, and the before/after
// comparison for a picked change.
import { getJson } from '../api.mjs';
import { el, spinnerNode } from '../dom.mjs';
import { formatCost, formatPercent, formatTokens, shortDate, localDateStr, axisTokens, axisCost } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { createSequence } from '../guards.mjs';
import {
  WEEK_MS, markerDate, markerIcon, timeDomain, drawSessionStartChart, drawMetricChart,
} from '../charts/setup-changes.mjs';

// Days of history the setup charts show for each range picker value. Today and 7d
// show 14 days, since a day or a week holds too few sessions to read a trend.
// null is all history.
function visibleDays() {
  if (state.currentDays === 'all') return null;
  return state.currentDays === 'today' || state.currentDays === 7 ? 14 : state.currentDays;
}

function chartDomain(report) {
  return rangeDomain(timeDomain(report, BA_ROWS.map((row) => row.key)), visibleDays());
}
const tokensCell = (v) => formatTokens(Math.round(v));
// One decimal place: the API-call medians are often a half.
const axisCount = (v) => String(Math.round(v * 10) / 10);
const axisPercent = (x) => `${Math.round(x * 100)}%`;

// Each row of the before/after table, and the daily chart it shows when picked:
// title names the chart, axis formats its y-axis, unit (unitOne when n is 1) follows n in a bar's tooltip.
const BA_ROWS = [
  { name: 'Session start context', key: 'sessionStart', n: 'sessions', unit: 'sessions', unitOne: 'session', fmt: tokensCell, axis: axisTokens, title: 'Median context at session start, tokens per day' },
  { name: 'Bash result, median', key: 'bashMedian', n: 'bashN', unit: 'Bash calls', unitOne: 'Bash call', fmt: tokensCell, axis: axisTokens, title: 'Median Bash result on the main thread, tokens per day' },
  { name: 'Bash result, p90', key: 'bashP90', n: 'bashN', unit: 'Bash calls', unitOne: 'Bash call', fmt: tokensCell, axis: axisTokens, title: '90th percentile Bash result on the main thread, tokens per day' },
  { name: 'Cost per prompt, median', key: 'costPerPrompt', n: 'prompts', unit: 'prompts', unitOne: 'prompt', fmt: formatCost, axis: axisCost, title: 'Median cost per prompt, per day' },
  { name: 'API calls per prompt, median', key: 'callsPerPrompt', n: 'prompts', unit: 'prompts', unitOne: 'prompt', fmt: axisCount, axis: axisCount, title: 'Median API calls per prompt, per day' },
  { name: 'Cache hit rate', key: 'cacheHit', n: 'callN', unit: 'API calls', unitOne: 'API call', fmt: formatPercent, axis: axisPercent, points: true, title: 'Cache hit rate, per day' },
];
const RTK_ROWS = [
  { name: 'Tokens kept per command', key: 'keptPerCommand', n: 'commands', unit: 'commands', unitOne: 'command', fmt: tokensCell, axis: axisTokens, rtk: true, title: 'Tokens rtk kept per command, per day' },
  { name: 'Share of output filtered', key: 'filteredShare', n: 'commands', unit: 'commands', unitOne: 'command', fmt: formatPercent, axis: axisPercent, points: true, rtk: true, title: 'Share of output rtk filtered, per day' },
];

// A share (cache hit, filtered) changes in percentage points; everything else as a
// relative change. Either way, a change under 5% relative to the "before" value is
// shown dimmed with no arrow, per spec: the spike measured day-to-day swings well
// above that on every row. A zero "before" value has no relative change to compute,
// so it falls back to the same dimmed dash as a missing before or after value.
function changeCell(a, b, points) {
  const td = el('td', { class: 'num' });
  if (a == null || b == null || a === 0) {
    td.textContent = '—';
    td.classList.add('dim');
    return td;
  }
  const diff = points ? (b - a) * 100 : ((b - a) / a) * 100;
  const small = Math.abs((b - a) / a) < 0.05;
  td.textContent = `${diff > 0 ? '+' : ''}${Math.round(diff)}${points ? ' pts' : '%'}`;
  td.classList.add(small ? 'dim' : diff < 0 ? 'down' : 'up');
  return td;
}

// The label is a button so a keyboard user can pick the row. A click anywhere on
// the row picks it too.
function baRow(row, before, after, onSelect) {
  const a = before ? before[row.key] : null;
  const b = after ? after[row.key] : null;
  const name = el('td', {}, [el('button', { type: 'button', class: 'ba-row-btn', 'aria-pressed': 'false', text: row.name })]);
  if (row.n) name.appendChild(el('span', { class: 'n', text: `n ${before ? before[row.n] : 0}→${after ? after[row.n] : 0}` }));
  const tr = el('tr', { 'data-key': row.key }, [
    name,
    el('td', { class: 'num', text: a == null ? '—' : row.fmt(a) }),
    el('td', { class: 'num', text: b == null ? '—' : row.fmt(b) }),
    changeCell(a, b, row.points),
  ]);
  tr.addEventListener('click', onSelect);
  return tr;
}

function renderBeforeAfter(report, marker) {
  const table = document.getElementById('beforeAfterTable');
  const note = document.getElementById('overlapNote');
  table.replaceChildren();
  note.textContent = '';
  if (!marker) return;
  const head = el('tr', {}, ['7 days', 'before', 'after', 'change'].map((text, i) => el('th', { text, class: i ? 'num' : '' })));
  const pick = (row) => () => selectRow(report, marker, row.key);
  const body = el('tbody', {}, BA_ROWS.map((row) => baRow(row, marker.before, marker.after, pick(row))));
  if (marker.before.rtk || marker.after.rtk) {
    body.appendChild(el('tr', { class: 'group' }, [el('td', { text: "From rtk's own history", colspan: '4' })]));
    for (const row of RTK_ROWS) body.appendChild(baRow(row, marker.before.rtk, marker.after.rtk, pick(row)));
  }
  table.append(el('thead', {}, [head]), body);

  const near = report.markers.filter((o) => o !== marker && Math.abs(o.t - marker.t) <= WEEK_MS);
  // Claude Code ships about once a day, so its releases get their own line instead
  // of burying the user's own changes in the list.
  const own = near.filter((o) => o.kind !== 'claude-code');
  const releases = near.filter((o) => o.kind === 'claude-code');
  const lines = [
    own.length
      ? `Also in this window: ${own.map((o) => `${markerDate(o.t)} ${o.label}`).join('; ')}`
      : 'No other change in this window.',
  ];
  if (releases.length) {
    lines.push(`Claude Code releases in this window: ${releases.map((o) => o.version).join(', ')}`);
  }
  note.replaceChildren(...lines.flatMap((text, i) => (i ? [el('br'), text] : [text])));
}

const markerKey = (m) => `${m.t}|${m.label}`;
let changesReport = null;
let selectedMarkerKey = null;

// The row whose daily chart shows. Kept across marker changes, redraws and
// refreshes; a page load starts again on the first row.
let selectedRowKey = 'sessionStart';

// The row the chart shows: the selected one, or the first row when the selected
// row is an rtk row and the report has no rtk series. selectedRowKey keeps the rtk
// key, so the rtk row comes back when rtk does.
function chartRow(report) {
  return [...BA_ROWS, ...RTK_ROWS].find((row) => row.key === selectedRowKey && report.daily[row.key]) || BA_ROWS[0];
}

// Moves the selection marks to the picked row and redraws its chart. The table is
// not rebuilt, so keyboard focus stays on the button that was pressed.
function selectRow(report, marker, key) {
  selectedRowKey = key;
  const row = chartRow(report);
  for (const tr of document.querySelectorAll('#beforeAfterTable tr[data-key]')) {
    const on = tr.dataset.key === row.key;
    tr.classList.toggle('selected', on);
    tr.querySelector('.ba-row-btn').setAttribute('aria-pressed', String(on));
  }
  document.getElementById('baChartTitle').textContent = row.title;
  const chart = document.getElementById('baDailyChart');
  chart.setAttribute('aria-label', row.title);
  drawMetricChart(chart, report, marker, row, chartDomain(report));
}

function selectMarker(report, marker) {
  selectedMarkerKey = marker ? markerKey(marker) : null;
  for (const btn of document.querySelectorAll('#markerList .marker-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.key === selectedMarkerKey));
  }
  // A closed day still shows that it holds the selected change.
  const day = marker ? localDateStr(new Date(marker.t)) : null;
  for (const group of document.querySelectorAll('#markerList .marker-day')) {
    group.querySelector('.marker-day-btn').classList.toggle('has-selected', group.dataset.day === day);
  }
  renderBeforeAfter(report, marker);
  selectRow(report, marker, selectedRowKey);
}

function renderChangesFileNote(file) {
  const note = document.getElementById('changesFileNote');
  note.hidden = false;
  note.classList.toggle('changes-error', file.status === 'error');
  if (file.status === 'error') note.textContent = `Couldn't read all of ${file.path}: ${file.error}`;
  else if (file.status === 'missing') note.textContent = `Add other changes to ${file.path} (format in the README).`;
  else note.hidden = true;
}

// Changes grouped by local day, in report order. One day often holds many
// changes (17 on 9/28), and a flat list of every change pushed the comparison
// off screen. A day only opens and closes; the changes inside pick the comparison,
// because each change's before/after window is measured from its own time.
function groupMarkersByDay(markers) {
  const days = new Map();
  for (const m of markers) {
    const day = localDateStr(new Date(m.t));
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(m);
  }
  return [...days].map(([day, items]) => ({ day, items }));
}

function markerDayGroup(report, { day, items }, open) {
  const listId = `markerDay-${day}`;
  const kinds = [...new Set(items.map((m) => m.kind))];
  const toggle = el('button', { type: 'button', class: 'marker-day-btn', 'aria-controls': listId });
  toggle.append(...kinds.map((k) => markerIcon(k)), `${shortDate(day)} · ${items.length} change${items.length > 1 ? 's' : ''}`);
  const list = el('div', { class: 'marker-day-items', id: listId });
  for (const m of items) {
    const btn = el('button', { type: 'button', class: 'marker-btn', 'data-key': markerKey(m), 'aria-pressed': 'false' });
    btn.append(markerIcon(m.kind), m.label);
    btn.addEventListener('click', () => selectMarker(report, m));
    list.appendChild(btn);
  }
  const group = el('div', { class: 'marker-day', 'data-day': day }, [toggle, list]);
  const setOpen = (isOpen) => {
    list.hidden = !isOpen;
    toggle.setAttribute('aria-expanded', String(isOpen));
    group.classList.toggle('open', isOpen);
  };
  toggle.addEventListener('click', () => setOpen(list.hidden));
  setOpen(open);
  return group;
}

function renderChanges(report) {
  changesReport = report;
  document.getElementById('sessionStartPanel').hidden = false;
  document.getElementById('beforeAfterPanel').hidden = false;
  renderChangesFileNote(report.changesFile);
  if (shown('sessionStart')) drawSessionStartChart(document.getElementById('sessionStartChart'), document.getElementById('sessionStartLegend'), report, chartDomain(report));
  // The marker list, the Bash chart and the table all belong to the before/after panel.
  // Showing the panel again re-runs renderChanges: resumeRequests in main.mjs
  // calls loadChanges or redrawCharts, which calls redrawChanges.
  if (!shown('beforeAfter')) return;

  const list = document.getElementById('markerList');
  list.replaceChildren();
  if (!report.markers.length) {
    list.appendChild(el('p', { class: 'panel-note', text: 'No changes to compare yet.' }));
    selectMarker(report, null);
    return;
  }
  const selected = report.markers.find((m) => markerKey(m) === selectedMarkerKey)
    || report.markers[report.markers.length - 1];
  const selectedDay = localDateStr(new Date(selected.t));
  for (const group of groupMarkersByDay(report.markers)) {
    list.appendChild(markerDayGroup(report, group, group.day === selectedDay));
  }
  selectMarker(report, selected);
}

const CHANGES_CHARTS = ['sessionStartChart', 'baDailyChart'];

// /api/changes reads the all-history scan, about 2.4s when that cache entry is
// cold. Both panels show straight away with a placeholder, so the page does not
// jump when the data arrives. The chart draw functions clear their container, so
// the placeholder needs no explicit removal on success.
function showChangesLoading() {
  // A load in progress has no report yet: without this, a failed reload's catch
  // block would leave the previous report in place, and a later redraw (e.g. a
  // row expand) would show stale data instead of the error state it just set.
  changesReport = null;
  document.getElementById('sessionStartPanel').hidden = false;
  document.getElementById('beforeAfterPanel').hidden = false;
  for (const id of CHANGES_CHARTS) {
    document.getElementById(id).replaceChildren(
      el('div', { class: 'chart-loading' }, [spinnerNode(), document.createTextNode('Loading setup changes…')])
    );
  }
}

// Numbers each /api/changes request, as recordsLoads does in records.mjs.
const changesLoads = createSequence();

// The fetch does not depend on the range picker, so it loads once and again on
// Refresh. A range change only redraws from the loaded report. A response that is
// not from the newest request is dropped, whether it succeeded or failed, because
// the newest request draws both panels when it settles.
export async function loadChanges() {
  if (!neededRequests(state.hiddenKeys, state.currentDays).has('changes')) return;
  const isLatest = changesLoads.next();
  showChangesLoading();
  const report = await getJson('/api/changes');
  if (!isLatest()) return;
  try {
    if (report.error) throw new Error(report.error);
    renderChanges(report);
  } catch (err) {
    // A spinner that never stops reads as still loading, so it goes, and the
    // before/after panel has nothing to show without a report.
    for (const id of CHANGES_CHARTS) document.getElementById(id).replaceChildren();
    document.getElementById('beforeAfterPanel').hidden = true;
    document.getElementById('sessionStartPanel').hidden = false;
    const note = document.getElementById('changesFileNote');
    note.hidden = false;
    note.classList.add('changes-error');
    note.textContent = `Couldn't load setup changes: ${err.message}`;
  }
}

// Draws both panels again from the loaded report, after a range switch or at a
// new width. Does nothing before the first report arrives.
export function redrawChanges() {
  if (changesReport) renderChanges(changesReport);
}
