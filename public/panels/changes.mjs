// The Setup changes panel: change lanes, the daily chart and the before/after
// comparison for a picked change.
import { getJson } from '../api.mjs';
import { el, spinnerNode, hideTooltip, focusedRowName } from '../dom.mjs';
import { formatCost, formatPercent, formatTokens, localDateStr, axisTokens, axisCost } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { createSequence } from '../guards.mjs';
import {
  WEEK_MS, markerDate, markerIcon, timeDomain, drawMetricChart, drawMetricLegend,
} from '../charts/setup-changes.mjs';
import { visibleRows, showAllButton, refocusShowAll, keepShowAllFocus } from '../ui/show-all.mjs';

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
  { name: 'Session start context', key: 'sessionStart', n: 'sessions', unit: 'sessions', unitOne: 'session', fmt: tokensCell, axis: axisTokens, title: 'Context at session start: bars are the daily median, dots are sessions' },
  { name: 'Bash result, median', key: 'bashMedian', n: 'bashN', unit: 'Bash calls', unitOne: 'Bash call', fmt: tokensCell, axis: axisTokens, title: 'Median Bash result on the main thread, tokens per day' },
  { name: 'Bash result, p90', key: 'bashP90', n: 'bashN', unit: 'Bash calls', unitOne: 'Bash call', fmt: tokensCell, axis: axisTokens, title: '90th percentile Bash result on the main thread, tokens per day' },
  { name: 'Cost per prompt, median', key: 'costPerPrompt', n: 'prompts', unit: 'prompts', unitOne: 'prompt', fmt: formatCost, axis: axisCost, title: 'Median cost per prompt, per day' },
  { name: 'API calls per prompt, median', key: 'callsPerPrompt', n: 'prompts', unit: 'prompts', unitOne: 'prompt', fmt: axisCount, axis: axisCount, title: 'Median API calls per prompt, per day' },
  { name: 'Cache hit rate', key: 'cacheHit', n: 'callN', unit: 'API calls', unitOne: 'API call', fmt: formatPercent, axis: axisPercent, points: true, title: 'Cache hit rate, per day' },
  { name: 'Thinking share of output', key: 'thinkingShare', n: 'thinkingN', unit: 'calls that report thinking', unitOne: 'call that reports thinking', fmt: formatPercent, axis: axisPercent, points: true, title: 'Thinking share of output, per day' },
];
const RTK_ROWS = [
  { name: 'Tokens reaching context per command', key: 'reachedPerCommand', n: 'commands', unit: 'commands', unitOne: 'command', fmt: tokensCell, axis: axisTokens, rtk: true, title: 'Tokens per rtk command that reached context, per day' },
  { name: 'Share kept out of context', key: 'keptOutShare', n: 'commands', unit: 'commands', unitOne: 'command', fmt: formatPercent, axis: axisPercent, points: true, rtk: true, title: 'Share of output rtk kept out of context, per day' },
];

// A share (cache hit, kept out) changes in percentage points; everything else as a
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

// A change younger than 7 days has a partial after window. The header says how many
// days it covers. th text is uppercased by css/base.css.
function afterHeading(marker, now) {
  if (marker.t + WEEK_MS <= now) return 'after';
  return `after · ${afterDaysSoFar(marker.t, now)} of 7 days`;
}

function renderBeforeAfter(report, marker) {
  keepShowAllFocus('overlapNote', () => drawBeforeAfter(report, marker));
}

function drawBeforeAfter(report, marker) {
  const table = document.getElementById('beforeAfterTable');
  const box = document.getElementById('overlapNote');
  table.replaceChildren();
  box.replaceChildren();
  if (!marker) return;
  const head = el('tr', {}, ['7 days', 'before', afterHeading(marker, Date.now()), 'change'].map((text, i) => el('th', { text, class: i ? 'num' : '' })));
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
  const items = visibleRows(own, WINDOW_LIMIT, showAllWindow).map((o) => el('li', {}, [
    el('span', { class: 'window-time', text: markerDate(o.t) }),
    markerIcon(o.kind),
    el('span', { text: o.label }),
  ]));
  const parts = [el('div', { class: 'usage-group-title', text: own.length ? 'Also in this window' : 'No other change in this window' })];
  if (items.length) parts.push(el('ul', { class: 'window-list' }, items));
  const more = showAllButton(own.length, WINDOW_LIMIT, showAllWindow, () => {
    showAllWindow = !showAllWindow;
    renderBeforeAfter(report, marker);
    refocusShowAll('overlapNote');
  });
  if (more) parts.push(more);
  if (releases.length) {
    parts.push(el('p', { class: 'panel-note', text: `Claude Code releases in this window: ${releases.map((o) => o.version).join(', ')}` }));
  }
  box.replaceChildren(...parts);
}

let changesReport = null;
let selectedMarkerKey = null;

// The row whose daily chart shows. Kept across marker changes, redraws and
// refreshes; a page load starts again on the first row.
let selectedRowKey = 'sessionStart';

// "Also in this window" shows WINDOW_LIMIT changes until Show all.
const WINDOW_LIMIT = 5;
let showAllWindow = false;

// The row the chart shows: the selected one, or the first row when the selected
// row is an rtk row and the report has no rtk series. selectedRowKey keeps the rtk
// key, so the rtk row comes back when rtk does.
function chartRow(report) {
  return [...BA_ROWS, ...RTK_ROWS].find((row) => row.key === selectedRowKey && report.daily[row.key]) || BA_ROWS[0];
}

const chartLabel = (row) => `${row.title}, with setup changes by kind above the chart`;

// Puts keyboard focus back on the lane cell that had it before drawMetricChart
// rebuilt the SVG.
function refocusLaneCell(chart, name) {
  if (name === null) return;
  [...chart.querySelectorAll('.lane-cell')].find((cell) => cell.dataset.name === name)?.focus({ preventScroll: true });
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
  const domain = chartDomain(report);
  document.getElementById('baChartTitle').textContent = row.title;
  const chart = document.getElementById('baDailyChart');
  chart.setAttribute('aria-label', chartLabel(row));
  const refocus = focusedRowName(chart);
  drawMetricChart(chart, report, marker, row, domain, (m) => selectMarker(report, m));
  refocusLaneCell(chart, refocus);
  drawMetricLegend(document.getElementById('baLegend'), row, report, domain);
}

const timeOfDay = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayHeading = (t) => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function dayListRow(report, m, picked) {
  const btn = el('button', { type: 'button', class: 'day-change', 'data-name': markerKey(m), 'aria-pressed': String(picked) });
  btn.append(el('span', { class: 'day-change-time', text: timeOfDay(m.t) }), markerIcon(m.kind), el('span', { text: m.label }));
  btn.addEventListener('click', () => selectMarker(report, m));
  return btn;
}

// The picked change's day: a heading with the count, then one button per change
// that falls inside the chart domain, so every row has a glyph in the lanes.
// The list is rebuilt on every pick, so the row that had keyboard focus gets it
// back (focusedRowName).
function renderDayList(report, marker) {
  const list = document.getElementById('dayList');
  const refocus = focusedRowName(list);
  const day = localDateStr(new Date(marker.t));
  const inView = markersInDomain(report.markers, chartDomain(report));
  const items = inView.filter((m) => localDateStr(new Date(m.t)) === day).sort((a, b) => a.t - b.t);
  const heading = el('div', { class: 'usage-group-title day-list-head', text: `${dayHeading(marker.t)} · ${items.length} change${items.length === 1 ? '' : 's'}` });
  const rows = items.map((m) => dayListRow(report, m, markerKey(m) === markerKey(marker)));
  list.replaceChildren(heading, ...rows);
  if (refocus === null) return;
  rows.find((row) => row.dataset.name === refocus)?.focus({ preventScroll: true });
}

// The one entry for a pick, from a lane cell, a day list row or a range fallback.
// The picked change is remembered by key, so it survives redraws and range switches.
function selectMarker(report, marker) {
  const key = markerKey(marker);
  // A newly picked change starts with its window list collapsed.
  if (key !== selectedMarkerKey) showAllWindow = false;
  selectedMarkerKey = key;
  renderDayList(report, marker);
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

// The lanes, chart, table and day list show together or not at all. With no change
// in the range they give way to one line.
function showBody(visible) {
  document.getElementById('baBody').hidden = !visible;
  document.getElementById('baEmpty').hidden = visible;
}

function renderChanges(report) {
  changesReport = report;
  document.getElementById('beforeAfterPanel').hidden = false;
  renderChangesFileNote(report.changesFile);
  // Showing the panel again re-runs renderChanges: resumeRequests in main.mjs
  // calls loadChanges or redrawCharts, which calls redrawChanges.
  if (!shown('beforeAfter')) return;
  const marker = resolvePicked(report.markers, selectedMarkerKey, chartDomain(report));
  showBody(Boolean(marker));
  if (!marker) {
    hideTooltip();
    return;
  }
  selectMarker(report, marker);
}

const CHANGES_CHARTS = ['baDailyChart'];

// /api/changes reads the all-history scan, about 2.4s when that cache entry is
// cold. The panel shows straight away with a placeholder, so the page does not
// jump when the data arrives. The chart draw functions clear their container, so
// the placeholder needs no explicit removal on success.
function showChangesLoading() {
  // A load in progress has no report yet: without this, a failed reload's catch
  // block would leave the previous report in place, and a later redraw (e.g. a
  // row expand) would show stale data instead of the error state it just set.
  changesReport = null;
  showBody(true);
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
// the newest request draws the panel when it settles.
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
    document.getElementById('baBody').hidden = true;
    document.getElementById('baEmpty').hidden = true;
    document.getElementById('beforeAfterPanel').hidden = false;
    const note = document.getElementById('changesFileNote');
    note.hidden = false;
    note.classList.add('changes-error');
    note.textContent = `Couldn't load setup changes: ${err.message}`;
  }
}

// Draws the Setup changes panel again from the loaded report, after a range switch or at a
// new width. Does nothing before the first report arrives.
export function redrawChanges() {
  if (changesReport) renderChanges(changesReport);
}

// On entering the Analysis tab: redraws from the loaded report, or loads it the
// first time. The Now tab never loads it (neededRequests).
export function ensureChanges() {
  if (changesReport) redrawChanges();
  else loadChanges();
}
