import { state, shown } from './state.mjs';
import { getJson } from './api.mjs';
import { createSequence } from './guards.mjs';
import {
  formatCost, formatTokens, formatPercent, localDateStr, costPerDay,
  shortDate, fullDate, axisTokens, axisCost, escapeHtml,
} from './format.mjs';
import { el, spinnerNode } from './dom.mjs';
import { TOKEN_SERIES } from './charts/palette.mjs';
import { drawHBars } from './charts/hbars.mjs';
import { drawBarChart, drawCumulativeChart } from './charts/bar.mjs';
import { drawLogLineChart, drawTokenLegend } from './charts/line.mjs';
import { drawActivityHeatmap } from './charts/heatmap.mjs';
import { drawSplitBar } from './charts/split.mjs';
import {
  WEEK_MS, markerDate, markerIcon, timeDomain, drawSessionStartChart, drawMetricChart,
} from './charts/setup-changes.mjs';

import { requestLimits, renderLimits, renderLimitsBanner } from './panels/limits.mjs';
import { requestSessions, renderSessions } from './panels/sessions.mjs';
import { renderTimeline, resetTimeline } from './panels/timeline.mjs';
import { requestReviews, renderReviews, reviewsMark, reviewsSince } from './panels/reviews.mjs';
import { refreshRecords, renderWeekTotals, renderRecord } from './panels/records.mjs';
import { renderTools } from './panels/tools.mjs';
import { renderRtk } from './panels/rtk.mjs';
import { loadPricesSource, setupPrices } from './panels/prices.mjs';
import { renderModels } from './panels/models.mjs';

// #region setup changes

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
  // Showing the panel again re-runs renderChanges through showKeys (via redrawCharts or loadChanges).
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

// Numbers each /api/changes request, like recordsLoads.
const changesLoads = createSequence();

// The fetch does not depend on the range picker, so it loads once and again on
// Refresh. A range change only redraws from the loaded report. A response that is
// not from the newest request is dropped, whether it succeeded or failed, because
// the newest request draws both panels when it settles.
async function loadChanges() {
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

// #endregion

// #region panel light

// Lights the border of the panel under the pointer in cyan, near the pointer (see
// .panel::before in style.css). One pointermove listener on #app serves every
// panel, throttled to one update per frame. It runs only for a pointer that can
// hover and when reduced motion is off. The header cards are not .panel, so they
// never light.
function setupPanelLight() {
  if (!matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) return;
  const app = document.getElementById('app');
  let lit = null;
  let frame = 0;
  let last = null;
  app.addEventListener('pointermove', (e) => {
    last = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!last) return;
      const panel = last.target.closest ? last.target.closest('#app .panel') : null;
      if (panel !== lit) {
        if (lit) lit.classList.remove('lit');
        lit = panel;
        if (lit) lit.classList.add('lit');
      }
      if (!lit) return;
      const box = lit.getBoundingClientRect();
      lit.style.setProperty('--x', `${last.clientX - box.left}px`);
      lit.style.setProperty('--y', `${last.clientY - box.top}px`);
    });
  });
  app.addEventListener('pointerleave', () => {
    // A fast exit can land pointermove and pointerleave in one frame. Cancelling
    // the pending frame stops it from lighting the panel again after the leave.
    cancelAnimationFrame(frame);
    frame = 0;
    last = null;
    if (lit) lit.classList.remove('lit');
    lit = null;
  });
}

// #endregion

// #region row order

// Each row of panels (a full-width panel or a .panel-row pair) can be moved. The
// order is kept in localStorage as a list of row keys, so the page reopens as it
// was left. A row's key is its first heading's text, stored in data-row-key before
// any control is added to the heading. The collapsed-rows code reads the same key.
// Storage can throw (a private window, blocked site data), and then the page keeps
// the order in index.html.
const ROW_ORDER_KEY = 'cc-dashboard:row-order';

function assignRowKeys() {
  for (const row of document.querySelectorAll('#app > .panel-row, #app > .panel')) {
    const heading = row.querySelector('.panel-head h2');
    if (heading) row.dataset.rowKey = heading.textContent;
  }
}

function panelRows() {
  return [...document.querySelectorAll('#app > .panel-row[data-row-key], #app > .panel[data-row-key]')];
}

function currentRowKeys() {
  return panelRows().map((row) => row.dataset.rowKey);
}

function loadRowOrder() {
  try {
    return JSON.parse(localStorage.getItem(ROW_ORDER_KEY));
  } catch {
    return null;
  }
}

function saveRowOrder(keys) {
  try {
    if (keys) localStorage.setItem(ROW_ORDER_KEY, JSON.stringify(keys));
    else localStorage.removeItem(ROW_ORDER_KEY);
  } catch {
    // Not saved. The rows keep their new order for this page view.
  }
}

// Re-appends the rows to #app in the order of keys. The banners and #mainCards
// come before every row in index.html, so they stay first.
function applyRowOrder(keys) {
  const app = document.getElementById('app');
  const byKey = new Map(panelRows().map((row) => [row.dataset.rowKey, row]));
  for (const key of keys) app.appendChild(byKey.get(key));
}

function clearDropMarks(row) {
  row.classList.remove('drop-before', 'drop-after');
}

// Adds a handle to each row's first heading. Pressing the handle makes that row
// draggable, so a drag that starts anywhere else in the row selects text as
// before. The row under the pointer marks the drop point as a line on its top or
// bottom edge, whichever half the pointer is in. onDrop runs after each move.
// The handle's glyph is CSS content, so the heading's textContent is unchanged.
function setupRowDrag(onDrop) {
  let dragged = null;
  for (const row of panelRows()) {
    const handle = el('span', { class: 'row-handle', title: 'Drag to move', 'aria-hidden': 'true' });
    // A release anywhere clears draggable. Some browsers send a release off the
    // handle to the element under the pointer, so the handle's own listener would miss it.
    // A cancelled pointer (a touch the browser takes over for scrolling, say) sends
    // pointercancel and no pointerup, so either event clears it, and the one
    // AbortController removes both listeners together.
    handle.addEventListener('pointerdown', () => {
      row.draggable = true;
      const release = new AbortController();
      const end = () => {
        row.draggable = false;
        release.abort();
      };
      document.addEventListener('pointerup', end, { signal: release.signal });
      document.addEventListener('pointercancel', end, { signal: release.signal });
    });
    row.querySelector('.panel-head h2').prepend(handle);

    // A drag of selected text, a link or an image inside the row targets that
    // element, not the row, so only a drag from the handle moves the row.
    row.addEventListener('dragstart', (e) => {
      if (e.target !== row) return;
      dragged = row;
      row.classList.add('row-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.rowKey);
    });
    // A drag that did not start from a handle, such as a file from the desktop,
    // leaves dragged null, so no row accepts the drop.
    row.addEventListener('dragover', (e) => {
      if (!dragged || dragged === row) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget)) clearDropMarks(row);
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = row.classList.contains('drop-after');
      clearDropMarks(row);
      row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
      onDrop();
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('row-dragging');
      dragged = null;
    });
  }
}

// Runs before setupCollapsibleRows, which reads data-row-key.
function setupRowOrder() {
  assignRowKeys();
  const defaultKeys = currentRowKeys();
  const saved = loadRowOrder();
  applyRowOrder(orderRowKeys(defaultKeys, saved));

  const resetBtn = document.getElementById('resetLayoutBtn');
  resetBtn.hidden = saved == null;
  resetBtn.addEventListener('click', () => {
    applyRowOrder(defaultKeys);
    saveRowOrder(null);
    resetBtn.hidden = true;
  });

  setupRowDrag(() => {
    saveRowOrder(currentRowKeys());
    resetBtn.hidden = false;
  });
}

// #endregion

// #region collapsible rows

// Each visual row of panels collapses to its headings. A two-panel row collapses
// as one, and a full-width panel is a row of its own. Collapsed rows are kept in
// localStorage, keyed by data-row-key (see the row order region), so the page
// reopens as it was left. Storage can throw (a private window, blocked site data),
// and then every row starts expanded.
const COLLAPSED_ROWS_KEY = 'cc-dashboard:collapsed-rows';

function loadCollapsedRows() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_ROWS_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveCollapsedRows(keys) {
  try {
    localStorage.setItem(COLLAPSED_ROWS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved. The row still toggles for this page view.
  }
}

function setupCollapsibleRows() {
  const collapsed = loadCollapsedRows();
  for (const row of document.querySelectorAll('#app > .panel-row, #app > .panel')) {
    const headings = [...row.querySelectorAll('.panel-head h2')];
    if (!headings.length) continue;
    const key = row.dataset.rowKey;
    const names = headings.map((h) => h.textContent).join(' and ');
    const toggle = el('button', { type: 'button', class: 'row-toggle' });
    const setCollapsed = (isCollapsed) => {
      row.classList.toggle('row-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${names}`);
    };
    toggle.addEventListener('click', () => {
      const isCollapsed = !row.classList.contains('row-collapsed');
      setCollapsed(isCollapsed);
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsedRows(collapsed);
      // A chart drawn while hidden has the 200px fallback width, so an expand
      // needs a redraw. redrawCharts draws the payload charts from lastPayload;
      // the changes charts are redrawn only when this row holds them.
      if (!isCollapsed) redrawCharts({ changes: row.id === 'sessionStartPanel' || row.id === 'beforeAfterPanel' });
    });
    headings[0].prepend(toggle);
    setCollapsed(collapsed.has(key));
  }
}

// The Skills and Subagents lists in Where usage goes each collapse to their title.
// They start collapsed from the markup on every load, and the state is not saved.
// The toggles sit outside #skillBars and #subagentBars, which drawHBars
// rebuilds on every render, so a re-render leaves an open list open.
function setupUsageGroupToggles() {
  for (const toggle of document.querySelectorAll('#attributionPanel .group-toggle')) {
    const group = toggle.closest('.usage-group');
    toggle.addEventListener('click', () => {
      const isCollapsed = !group.classList.contains('group-collapsed');
      group.classList.toggle('group-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${toggle.dataset.name}`);
    });
  }
}

// #endregion

// #region hidden panels

// Any panel or summary card can be hidden with its "x" button and shown again
// from the ☰ menu in the header. The hidden keys (data-hide-key in index.html)
// are kept in localStorage. A hidden element gets data-user-hidden, which
// style.css hides with !important, so a renderer setting `panel.hidden = false`
// cannot show it. Storage can throw (a private window, blocked site data), and
// then nothing starts hidden.
const HIDDEN_KEY = 'cc-dashboard:hidden';

function loadHidden() {
  try {
    return new Set(parseHidden(localStorage.getItem(HIDDEN_KEY)));
  } catch {
    return new Set();
  }
}

function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hiddenKeys]));
  } catch {
    // Not saved. The change holds for this page view.
  }
}

state.hiddenKeys = loadHidden();

// The name in the menu and in the "x" button's label: the panel's heading or the
// card's label. The row handle and toggle in a heading add no text.
function hideName(element) {
  const label = element.querySelector('.panel-head h2, .card-label');
  return label ? label.textContent.trim() : element.dataset.hideKey;
}

// setupRowDrag and setupCollapsibleRows put a row's handle and toggle in its first
// heading. When the first panel of a pair is hidden, they move to the heading of
// the panel still showing, and back when the first panel returns.
function placeRowControls(row, panel) {
  const heading = panel.querySelector(':scope > .panel-head > h2');
  const toggle = row.querySelector(':scope > .panel > .panel-head > h2 > .row-toggle');
  const handle = row.querySelector(':scope > .panel > .panel-head > h2 > .row-handle');
  if (heading && toggle && toggle.parentElement !== heading) heading.prepend(...[toggle, handle].filter(Boolean));
}

function applyHidden() {
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    element.toggleAttribute('data-user-hidden', state.hiddenKeys.has(element.dataset.hideKey));
  }
  for (const row of document.querySelectorAll('#app > .panel-row')) {
    const panels = [...row.querySelectorAll(':scope > .panel')];
    const visible = panels.filter((panel) => !panel.hasAttribute('data-user-hidden'));
    row.toggleAttribute('data-user-hidden', visible.length === 0);
    placeRowControls(row, visible[0] || panels[0]);
  }
  renderHiddenMenu();
}

function hideKey(key) {
  state.hiddenKeys.add(key);
  saveHidden();
  applyHidden();
  const element = document.querySelector(`[data-hide-key="${key}"]`);
  // The other panel of a pair widens to the full row, so its SVG needs a redraw at the new width.
  if (element && element.closest('.panel-row')) redrawCharts({ changes: false });
}

// A hidden panel was not drawn, so showing one redraws the page. A request that
// was skipped because all its panels were hidden runs again here. rtk, sessions
// and reviews come from fetchAll, and lastPayload holds null for a skipped one, so
// when one of those three resumes, redrawCharts loads the page again.
function showKeys(keys) {
  const before = neededRequests(state.hiddenKeys, state.currentDays);
  for (const key of keys) state.hiddenKeys.delete(key);
  saveHidden();
  applyHidden();
  const after = neededRequests(state.hiddenKeys, state.currentDays);
  const resumed = (request) => after.has(request) && !before.has(request);
  if (resumed('records')) refreshRecords();
  if (resumed('prices')) loadPricesSource();
  // loadChanges renders both changes panels itself when it finishes.
  if (resumed('changes')) loadChanges();
  redrawCharts({ changes: !resumed('changes'), refetch: ['rtk', 'sessions', 'reviews'].some(resumed) });
}

// One button per hidden element, in page order, then Show all when two or more
// are hidden. Choosing one closes the menu, and the popover returns focus to ☰.
function renderHiddenMenu() {
  const menu = document.getElementById('hiddenMenu');
  const hidden = [...document.querySelectorAll('[data-hide-key][data-user-hidden]')];
  menu.replaceChildren();
  if (!hidden.length) {
    menu.appendChild(el('p', { class: 'hidden-menu-empty', text: 'Nothing hidden' }));
    return;
  }
  const choose = (keys) => {
    menu.hidePopover();
    showKeys(keys);
  };
  for (const element of hidden) {
    const name = hideName(element) + (element.classList.contains('card') ? ' · card' : '');
    const item = el('button', { type: 'button', class: 'hidden-menu-item', text: name });
    item.addEventListener('click', () => choose([element.dataset.hideKey]));
    menu.appendChild(item);
  }
  if (hidden.length >= 2) {
    const all = el('button', { type: 'button', class: 'hidden-menu-item hidden-menu-all', text: 'Show all' });
    all.addEventListener('click', () => choose(hidden.map((element) => element.dataset.hideKey)));
    menu.appendChild(all);
  }
}

// Adds the "x" to each panel's head and each card, and places the menu under ☰
// each time it opens. Hiding moves focus to ☰, because the focused "x" has just
// disappeared with its panel.
function setupHiding() {
  const menuBtn = document.getElementById('hiddenMenuBtn');
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    const name = hideName(element);
    const btn = el('button', { type: 'button', class: 'hide-btn', 'aria-label': `Hide ${name}`, title: `Hide ${name}`, text: '×' });
    btn.addEventListener('click', () => {
      hideKey(element.dataset.hideKey);
      menuBtn.focus();
    });
    (element.querySelector(':scope > .panel-head') || element).appendChild(btn);
  }
  const menu = document.getElementById('hiddenMenu');
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const box = menuBtn.getBoundingClientRect();
    menu.style.top = `${box.bottom + 6}px`;
    menu.style.right = `${document.documentElement.clientWidth - box.right}px`;
  });
  applyHidden();
}

// #endregion

// #region app state + rendering

const LIVE_POLL_MS = 5000;
// While live, runLoad runs LIVE_POLL_MS after the previous run finished
// (createPoller in public/poll.js), so a slow scan delays the next poll instead of
// overlapping it.
const livePoller = createPoller(() => runLoad(), LIVE_POLL_MS);
// Signature of the last rendered payload. A 5s poll that redraws unconditionally
// would tear down the SVG under the cursor and kill any open tooltip, so an
// unchanged payload skips rendering entirely.
let lastSignature = null;
// Numbers each fetchAll (see createSequence). A 30d request issued before a
// Today click lands after it, and is dropped.
const loads = createSequence();
// The newest payload fetchAll returned. redrawCharts draws from it after a resize,
// a hide or an expand, so a change of width makes no request. The range picker
// sets it to null, because renderPayload reads state.currentDays and would draw the old
// range's buckets with the new range's rules.
let lastPayload = null;

// Time of the last successful summary load, shown as Sync in the status strip.
let lastLoadedAt = null;

// Fills the status strip under the title. loadAndRender calls it on every
// successful summary load, before renderPayload's unchanged-payload check, so Sync
// moves on a quiet poll too. While live, the ring pulses once per call.
function renderStatusStrip(summary) {
  const active = document.querySelector('#rangePicker button.active');
  const status = formatStatus({
    loadedAt: lastLoadedAt,
    range: active ? active.textContent : '',
    sessions: summary.sessions,
    apiCalls: summary.apiCalls,
  });
  document.getElementById('stripSync').textContent = status.sync;
  document.getElementById('stripRange').textContent = status.range;
  document.getElementById('stripSessions').textContent = status.sessions;
  document.getElementById('stripCalls').textContent = status.apiCalls;
  if (!livePoller.running) return;
  const ring = document.querySelector('#liveDot .live-ring');
  ring.classList.remove('ping');
  void ring.offsetWidth; // restarts the animation on the next add
  ring.classList.add('ping');
}

// A range switch, Refresh or first load can take seconds (a cold 30d scan takes
// ~1.9s, All longer), and the previous range's numbers stay on screen meanwhile.
// Those loads mark the page busy, but only after 250ms, so a ~0.17s Today load
// never flashes a spinner. The status element stays in the DOM so screen readers
// track it as a live region.
const BUSY_DELAY_MS = 250;
let busyTimer = null;

function setBusy(on) {
  clearTimeout(busyTimer);
  busyTimer = null;
  const main = document.getElementById('app');
  const status = document.getElementById('loadStatus');
  if (!on) {
    main.removeAttribute('aria-busy');
    status.replaceChildren();
    return;
  }
  busyTimer = setTimeout(() => {
    main.setAttribute('aria-busy', 'true');
    status.replaceChildren(spinnerNode(), document.createTextNode('Loading…'));
  }, BUSY_DELAY_MS);
}

function setLive(on) {
  if (on) livePoller.start();
  else livePoller.stop();
  document.getElementById('liveDot').classList.toggle('is-off', !on);
  document.querySelector('#liveDot .live-text').textContent = on ? 'Link live' : 'Paused';
  // A live range re-scans every 5 seconds, so a manual refresh has nothing to do.
  document.getElementById('refreshBtn').hidden = on;
}

// On Today the summary cards sit in the sticky header in a compact form, so they
// stay in view while scrolling. Other ranges show them as full cards in the page.
// The one #summaryCards element moves between the two slots, so every card id
// stays unique and renderPayload fills it the same way wherever it is.
function placeSummaryCards() {
  const cards = document.getElementById('summaryCards');
  const today = state.currentDays === 'today';
  document.getElementById(today ? 'headerCards' : 'mainCards').appendChild(cards);
  cards.classList.toggle('cards-compact', today);
  // Hidden off Today, so the empty slot cannot wrap onto a line of its own.
  document.getElementById('headerCards').hidden = !today;
  // renderPayload hides these two on Today too, but only once the load finishes.
  // Hiding them here keeps the old range's values out of the header meanwhile.
  if (today) {
    document.getElementById('burnCard').hidden = true;
    document.getElementById('projectionCard').hidden = true;
  }
}

// Issues the five requests and waits for all of them. Returns { data, rtk, limits,
// sessions, reviews }, or null when a newer load started while this one waited.
async function fetchAll({ busy = false } = {}) {
  const isLatest = loads.next();

  // Only user-started loads show the busy state. Whichever request is newest
  // clears it when it settles, even a quiet poll, because an older busy request's
  // response is dropped below and would never clear it.
  if (busy) setBusy(true);

  // Every request is issued before any is awaited, so the summary never
  // waits on the others. None of the promises rejects (getJson never does). rtk and limits
  // are optional and resolve to null on failure, so an absent or unreadable source
  // hides its panel. A failed summary resolves to an error payload, which
  // renderPayload turns into the error banner after limits have rendered.
  const summaryRequest = getJson(`/api/summary?days=${state.currentDays}`);
  // A request whose every panel is hidden is skipped (see neededRequests in
  // visibility.js), and its panels render from null, as on a failed request.
  const needed = neededRequests(state.hiddenKeys, state.currentDays);
  const rtkRequest = needed.has('rtk')
    ? getJson(`/api/rtk?days=${state.currentDays}`, { optional: true })
    : Promise.resolve(null);

  const limitsRequest = requestLimits();
  // Only Today shows the sessions panels, so other ranges skip the request and
  // its Today scan.
  const sessionsRequest = needed.has('sessions') ? requestSessions() : Promise.resolve(null);
  const mark = reviewsMark();
  const reviewsRequest = needed.has('reviews') ? requestReviews() : Promise.resolve(null);

  const [data, rtk, limits, sessions, reviews] = await Promise.all([summaryRequest, rtkRequest, limitsRequest, sessionsRequest, reviewsRequest]);
  if (!isLatest()) return null; // a newer request superseded this response
  setBusy(false);
  if (!data.error) lastLoadedAt = Date.now();
  // A dismiss or undo during the requests keeps the reviews on screen (reviewsSince).
  lastPayload = { data, rtk, limits, sessions, reviews: reviewsSince(mark, reviews) };
  return lastPayload;
}

// Draws a payload from fetchAll. lastSignature is set on the last line, after every
// renderer has run. A renderer that throws therefore leaves the previous signature,
// and reportDrawError clears that one. The four panel guards keep no key for a
// draw that threw, so those panels need no clearing.
function renderPayload({ data, rtk, limits, sessions, reviews }) {
  const banner = document.getElementById('statusBanner');

  // Plan usage describes right now: its "stale" suffix and its reset wording
  // (today vs. a dated form) depend on the clock, not on the fetched numbers, so
  // this has to run on every settled response. That includes one whose summary
  // failed, and one the signature below would otherwise treat as unchanged.
  // These three panels show on Today only. Their renderers set that, but a hidden
  // panel's renderer is skipped, so the range rule is applied here too.
  if (state.currentDays !== 'today') {
    for (const id of ['limitsPanel', 'sessionsPanel', 'timelinePanel']) document.getElementById(id).hidden = true;
  }
  if (shown('limits')) renderLimits(limits);
  if (shown('sessions')) renderSessions(sessions);
  if (shown('timeline')) renderTimeline(sessions);
  if (shown('reviews')) renderReviews(reviews);
  renderLimitsBanner(limits);

  if (data.error) {
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${data.error}`;
    lastSignature = null;
    return;
  }

  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models, rtk && rtk.summary]);
  if (signature === lastSignature) return;
  banner.hidden = true;

  if (!data.meta.dirExists) {
    banner.hidden = false;
    banner.innerHTML = `No Claude Code project logs found at <code>${escapeHtml(data.meta.projectsDir)}</code>. Use Claude Code at least once, or set <code>CLAUDE_CONFIG_DIR</code> if you use a custom location.`;
  } else if (data.meta.scannedFiles === 0) {
    banner.hidden = false;
    banner.textContent = 'Found the projects folder, but no session files yet.';
  }

  const s = data.summary;
  if (shown('card-cost')) {
    document.getElementById('cardCost').textContent = formatCost(s.totalCost);
    // The compact header card on Today has room for a short note only, so there
    // the full sentence moves to the note's tooltip.
    const unpricedNote = s.unpricedTokens
      ? `${formatTokens(s.unpricedTokens)} tokens from unrecognized models not priced`
      : '';
    const costNote = document.getElementById('cardCostNote');
    const compact = state.currentDays === 'today';
    costNote.textContent = compact && s.unpricedTokens
      ? `${formatTokens(s.unpricedTokens)} unpriced`
      : unpricedNote;
    costNote.title = compact ? unpricedNote : '';
  }
  if (shown('card-tokens')) document.getElementById('cardTokens').textContent = formatTokens(s.totalTokens);
  renderWeekTotals(s);
  if (shown('card-cache')) document.getElementById('cardCache').textContent = formatPercent(s.cacheEfficiency);

  // Claude Code's own per-session counters, shown as a separate card rather than
  // folded into Total cost. Only present on the all-time range, and only for the
  // sessions that wrote a cost-state line, so it is a floor on what the
  // per-request scan misses, not a replacement total.
  const reportedCard = document.getElementById('reportedCard');
  reportedCard.hidden = s.reportedCost == null;
  if (s.reportedCost != null && shown('card-reported')) {
    document.getElementById('cardReported').textContent = formatCost(s.reportedCost);
    document.getElementById('cardReportedNote').textContent =
      `${s.reportedSessions} of ${s.reportedSessionsOf} sessions`;
  }
  if (shown('card-files')) document.getElementById('cardFiles').textContent = data.meta.scannedFiles;
  if (shown('card-tools')) document.getElementById('cardTools').textContent = s.toolCalls.toLocaleString('en-US');
  if (shown('card-record')) renderRecord(data.daily);

  if (shown('dailyCost')) {
    drawBarChart(document.getElementById('costChart'), data.daily, {
      color: 'var(--accent-cost)',
      valueKey: 'cost',
      tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatCost(d.cost)}`,
    });
  }

  if (shown('dailyTokens')) {
    // The payload carries the four token types per bucket but not their sum, so the
    // total is derived here rather than widening the wire format for one chart.
    const dailyTokens = data.daily.map((d) => ({
      ...d,
      tokens: d.input + d.output + d.cacheCreate + d.cacheRead,
    }));
    drawBarChart(document.getElementById('tokenChart'), dailyTokens, {
      // Cache reads are ~97% of every total, so this borrows their colour rather
      // than adding a sixth hue to a palette validated as a set.
      color: '#9085e9',
      valueKey: 'tokens',
      tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatTokens(d.tokens)} tokens`,
    });
  }

  if (shown('cumulativeCost')) drawCumulativeChart(document.getElementById('cumulativeChart'), data.daily);

  // Hourly buckets on the Today range, where a daily rate has no meaning.
  const perDay = state.currentDays === 'today' ? null : costPerDay(data.daily);
  document.getElementById('burnCard').hidden = perDay == null;
  document.getElementById('projectionCard').hidden = perDay == null;
  if (perDay != null && shown('card-burn')) document.getElementById('cardBurn').textContent = formatCost(perDay);
  if (perDay != null && shown('card-projection')) document.getElementById('cardProjection').textContent = formatCost(perDay * 30);

  if (shown('tokenTypes')) {
    // Reversed so the legend reads in the order the lines actually appear, cache read
    // at the top down to input at the bottom. TOKEN_SERIES is copied, not reversed in
    // place: the stacked charts rely on its order.
    drawTokenLegend(document.getElementById('tokenTypeLegend'), data.daily, [...TOKEN_SERIES].reverse(), true);
    drawLogLineChart(document.getElementById('tokenTypeChart'), data.daily, TOKEN_SERIES);
  }

  // Every bar in the panel shares one scale. Groups on separate scales made a
  // 30.8% subagent bar draw longer than a 68.2% thread bar.
  // The two split bars are self-scaling, so only the skill and subagent lists
  // share this one, which is what keeps their lengths comparable to each other.
  const attributionScale = [...data.skills, ...data.subagents].reduce((max, r) => Math.max(max, r.cost), 0);
  const totalCost = data.summary.totalCost;
  // Skill and subagent rows: the bar against the shared scale, the text the true
  // share of total cost.
  const shareOfTotal = (row) => `${(totalCost > 0 ? (row.cost / totalCost) * 100 : 0).toFixed(1)}%`;
  const usageBars = {
    size: (row) => row.cost,
    scaleMax: attributionScale,
    value: shareOfTotal,
    tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${shareOfTotal(row)} of total`,
    empty: 'Nothing attributed in this range.',
  };
  const threadRows = [
    { name: 'Main thread', cost: data.threads.main },
    { name: 'Subagents', cost: data.threads.subagent },
  ];
  const contextRows = [
    { name: `Over ${axisTokens(data.contextThreshold)} context`, cost: data.context.over },
    { name: `Under ${axisTokens(data.contextThreshold)} context`, cost: data.context.under },
  ];
  document.getElementById('attributionPanel').hidden = totalCost <= 0;
  if (shown('attribution')) {
    drawSplitBar(document.getElementById('threadBars'), threadRows);
    drawSplitBar(document.getElementById('contextBars'), contextRows);
    drawHBars(document.getElementById('skillBars'), data.skills.slice(0, 8), usageBars);
    drawHBars(document.getElementById('subagentBars'), data.subagents.slice(0, 8), usageBars);
  }

  if (shown('tools')) renderTools(data.tools || []);

  renderModels(data);

  // Like the model daily charts, the heatmap shows on multi-day ranges only.
  const multiDay = state.currentDays !== 'today';
  document.getElementById('activityPanel').hidden = !multiDay;
  if (multiDay && shown('activity')) drawActivityHeatmap(document.getElementById('activityHeatmap'), data.activity);

  renderRtk(rtk);
  lastSignature = signature;
}

async function loadAndRender(options) {
  const payload = await fetchAll(options);
  if (!payload) return;
  // Sync moves on every successful load, a quiet poll included, so the strip is
  // filled before renderPayload's unchanged-payload check.
  if (!payload.data.error) renderStatusStrip(payload.data.summary);
  renderPayload(payload);
}

// A renderer that throws would otherwise reject loadAndRender with nothing to catch
// it, and leave the page half drawn with no message. The banner names the error,
// and clearing lastSignature makes the next poll draw every panel again.
function reportDrawError(err) {
  console.error(err);
  const banner = document.getElementById('statusBanner');
  banner.hidden = false;
  banner.textContent = `Couldn't draw the page: ${err?.message ?? err}`;
  lastSignature = null;
  resetTimeline();
}

// Every load goes through runLoad, so no caller leaves a rejection unhandled.
function runLoad(options) {
  return loadAndRender(options).catch(reportDrawError);
}

document.getElementById('rangePicker').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-days]');
  if (!btn) return;
  document.querySelectorAll('#rangePicker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.days;
  state.currentDays = value === 'all' || value === 'today' ? value : Number(value);
  placeSummaryCards();
  lastSignature = null; // the bucket keys change, so force a redraw
  lastPayload = null;
  setLive(state.currentDays === 'today');
  if (changesReport) renderChanges(changesReport);
  runLoad({ busy: true });
});

// Everything the Refresh button re-fetches. Applying prices calls it too, because
// costs are computed in the server's scan and the server has just dropped that scan.
function reloadAll() {
  lastSignature = null;
  refreshRecords();
  runLoad({ busy: true });
  loadChanges();
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  setBusy(true);
  // A rejected refresh (e.g. the server is down) must not skip runLoad in reloadAll:
  // its failed summary request is what clears busy and shows the error banner.
  await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
  reloadAll();
});

// Draws every chart again at the current widths, from lastPayload and with no
// request. It loads instead when there is no payload yet, or when showKeys passes
// refetch because a request skipped at the last load is needed again.
function redrawCharts({ changes = true, refetch = false } = {}) {
  lastSignature = null; // the width changed, so the same data still needs redrawing
  resetTimeline();
  if (refetch || !lastPayload) {
    runLoad();
  } else {
    try {
      renderPayload(lastPayload);
    } catch (err) {
      reportDrawError(err);
    }
  }
  if (changes && changesReport) renderChanges(changesReport);
}

// A resize redraws the charts at the new width, 150 ms after the last resize event.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawCharts, 150);
});

setupRowOrder();
setupCollapsibleRows();
setupHiding();
setupPanelLight();
setupUsageGroupToggles();
setupPrices({ onApplied: reloadAll });
placeSummaryCards();
setLive(state.currentDays === 'today');
refreshRecords();
runLoad({ busy: true });
loadChanges();
loadPricesSource();

// #endregion
