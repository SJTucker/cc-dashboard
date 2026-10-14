// The Setup changes timeline: change lanes, the window bar and the daily chart for
// the picked row, all in one SVG on one time axis.
import { el, svgEl, hideTooltip, chartWidth, withTooltip, withFocusTooltip } from '../dom.mjs';
import { formatTokens, shortDate, localDateStr, escapeHtml, modelLabel } from '../format.mjs';
import { drawPlotAxis } from './axes.mjs';
import { legendRow } from './legend.mjs';
import { appendPatternDefs, fillFor, textureCss, TOKENS } from './palette.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

// Five points at radius 5.5 and five notches at 2.3, starting at the top. No other
// marker has notches, so the star reads apart from the circle and the diamond.
function starPath(x, y) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 2.3 : 5.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${points.join(' L')} Z`;
}

// Shape carries the kind of change, so the marker row reads without colour.
const MARKER_SHAPES = {
  plugin: (x, y) => svgEl('path', { d: `M${x},${y - 5} L${x + 5},${y + 4} L${x - 5},${y + 4} Z` }),
  hook: (x, y) => svgEl('path', { d: `M${x - 5},${y - 4} L${x + 5},${y - 4} L${x},${y + 5} Z` }),
  skill: (x, y) => svgEl('rect', { x: x - 4, y: y - 4, width: 8, height: 8 }),
  'claude-md': (x, y) => svgEl('path', { d: `M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z` }),
  rtk: (x, y) => svgEl('circle', { cx: x, cy: y, r: 4.5 }),
  config: (x, y) => svgEl('path', { d: `M${x - 5},${y} L${x + 5},${y} M${x},${y - 5} L${x},${y + 5} M${x - 3.5},${y - 3.5} L${x + 3.5},${y + 3.5} M${x + 3.5},${y - 3.5} L${x - 3.5},${y + 3.5}` }),
  effort: (x, y) => svgEl('path', { d: `M${x - 4},${y - 4} L${x + 4},${y + 4} M${x + 4},${y - 4} L${x - 4},${y + 4}` }),
  model: (x, y) => svgEl('path', { d: `M${x - 5},${y} L${x + 5},${y} M${x},${y - 5} L${x},${y + 5}` }),
  'claude-code': (x, y) => svgEl('path', { d: starPath(x, y) }),
  other: (x, y) => svgEl('path', { d: `M${x - 5},${y} L${x + 5},${y}` }),
};

const MARKER_KIND_NAMES = {
  plugin: 'plugin', hook: 'hook', skill: 'skill', 'claude-md': 'CLAUDE.md', rtk: 'rtk',
  config: 'config', effort: 'effort', model: 'model', 'claude-code': 'Claude Code', other: 'other',
};

// Session dots: shape by model, most-used model first.
const DOT_SHAPES = [
  { square: false, hollow: false },
  { square: false, hollow: true },
  { square: true, hollow: false },
  { square: true, hollow: true },
];

function markerGlyph(kind, x, y) {
  const shape = (MARKER_SHAPES[kind] || MARKER_SHAPES.other)(x, y);
  shape.setAttribute('class', 'marker-glyph');
  return shape;
}

export function markerIcon(kind) {
  const svg = svgEl('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true', class: 'marker-icon' });
  svg.appendChild(markerGlyph(kind, 0, 0));
  return svg;
}

function sessionDot(shape, x, y) {
  const node = shape.square
    ? svgEl('rect', { x: x - 3, y: y - 3, width: 6, height: 6 })
    : svgEl('circle', { cx: x, cy: y, r: 3.2 });
  node.setAttribute('class', shape.hollow ? 'session-dot hollow' : 'session-dot');
  return node;
}

// A dot with an outline in the background colour, so it stays readable over a bar.
// The tooltip hangs on the group, which holds the outline and the dot.
function sessionDotNode(shape, x, y) {
  const halo = sessionDot(shape, x, y);
  halo.setAttribute('class', 'session-halo');
  const group = svgEl('g');
  group.append(halo, sessionDot(shape, x, y));
  return group;
}

function sessionsInView(report, domain) {
  return report.sessions.filter((s) => s.t >= domain[0] && s.t <= domain[1]);
}

// Shapes stay the same on every range: they rank models over every session.
function drawSessionDots(svg, report, g) {
  const shapes = modelShapes(report.sessions);
  for (const s of sessionsInView(report, g.domain)) {
    const dot = sessionDotNode(shapes.get(s.model), g.xOf(s.t), g.yOf(s.context));
    svg.appendChild(withTooltip(dot, sessionTooltip(s, g.max)));
  }
}

// The top of the y axis before headroom. On the Session start row it is the 95th
// percentile of the sessions in view: one outlier session (260,620 tokens against a
// typical 38k-52k) would otherwise squash every ordinary session into the bottom
// slice. The before and after median lines stay under the top even when they are
// above that percentile. Other rows, and a Session start range with no session, use
// the tallest bar or median line.
export function plotRawMax(row, days, win, inView) {
  const lines = win ? [win.before, win.after].filter((v) => v != null) : [];
  if (row.key === 'sessionStart' && inView.length) return Math.max(percentile(inView.map((s) => s.context), 95), ...lines);
  return Math.max(...days.map((d) => d.value), ...lines);
}

export function markerDate(t) {
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function dayNoon(dateKey) {
  return new Date(`${dateKey}T12:00`).getTime();
}

// The lanes and the chart share one time axis, so a change sits at the same x in both. This is
// the all-history axis; chartDomain narrows it to the range picker. Built from
// sessions and the daily series named by keys (the transcript rows of the
// before/after table) only. Markers and rtk days are left out. Claude Code
// deletes transcripts after cleanupPeriodDays (30 by default), so history has a
// sliding start, while rtk keeps every row. A marker or an rtk day from before
// the earliest surviving transcript would stretch the axis with an empty strip on
// one side. Markers outside the resulting domain are filtered out by
// markersInDomain (public/chart-geometry.js), and rtk days by daysInDomain.
export function timeDomain(report, keys) {
  const times = [
    ...report.sessions.map((s) => s.t),
    ...keys.flatMap((key) => report.daily[key].map((d) => dayNoon(d.date))),
  ];
  return [Math.min(...times) - DAY_MS / 2, Math.max(...times) + DAY_MS / 2];
}

// True when a marker falls inside the time axis of the Setup changes chart. A marker
// just outside it (see timeDomain above) draws no lane glyph, line, picked column or
// shaded window, and the day list leaves it out.
function markerInDomain(marker, domain) {
  return Boolean(marker) && marker.t >= domain[0] && marker.t <= domain[1];
}

function modelShapes(sessions) {
  const counts = new Map();
  for (const s of sessions) counts.set(s.model, (counts.get(s.model) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  return new Map(ranked.map((model, i) => [model, DOT_SHAPES[Math.min(i, DOT_SHAPES.length - 1)]]));
}

// Real value stays in the tooltip even for a dot clamped to the top edge below -
// only its position is capped at the 95th-percentile axis max, not the number shown.
function sessionTooltip(s, max) {
  const offScale = s.context > max ? ' (off the top of the scale)' : '';
  return `<strong>${escapeHtml(markerDate(s.t))}</strong><br>${formatTokens(s.context)} tokens at the first call${offScale}<br>${escapeHtml(s.model || 'unknown model')}`;
}

// The days of row's series inside the shared time axis. rtk keeps days the
// transcripts have lost (see timeDomain), so a day outside the axis is skipped.
function daysInDomain(report, row, domain) {
  return (report.daily[row.key] || []).filter((d) => {
    const t = dayNoon(d.date);
    return t >= domain[0] && t <= domain[1];
  });
}

// The marker's time and its 7-day before and after values for row. null when the
// marker is outside the shared time axis (see timeDomain): it then has no
// "before" this chart's x-axis can place, so it draws no shaded window, line or
// bar colouring. The rtk rows' 7-day values sit under .rtk, which is null when
// rtk is missing.
function markerWindow(marker, row, domain) {
  if (!markerInDomain(marker, domain)) return null;
  const before = row.rtk ? marker.before.rtk : marker.before;
  const after = row.rtk ? marker.after.rtk : marker.after;
  return { t: marker.t, before: before && before[row.key], after: after && after[row.key] };
}

// The before-window bars and the legend swatch use --text-secondary. A pattern's paint cannot be a CSS variable, so it comes from TOKENS.
const BEFORE_INK = TOKENS.textSecondary;
const PATTERN_SCOPE = 'ba';

// Where the plot starts: the left gutter holds each lane's glyph and name, and the
// y-axis labels. .ba-under in css/setup-changes.css indents the legend by the same amount.
export const PLOT_LEFT = 110;
const RIGHT_PAD = 10;
const PLOT_HEIGHT = 170;
const LANES_TOP = 6;
const LANE_HEIGHT = 20;
// From the bottom of the lanes to the top of the plot: the 6px window bar and room for median labels.
const BAR_BLOCK = 34;
const DATE_AXIS_HEIGHT = 22;

// Every y and x the chart parts share. Lanes sit on top (laneCount rows), then the
// window bar, then the plot, then the date labels. With no lanes the plot starts at the top.
function plotLayout(domain, width, laneCount) {
  const left = PLOT_LEFT;
  const right = width - RIGHT_PAD;
  const lanesBottom = LANES_TOP + laneCount * LANE_HEIGHT;
  const top = laneCount ? lanesBottom + BAR_BLOCK : LANES_TOP;
  const bottom = top + PLOT_HEIGHT;
  const span = domain[1] - domain[0];
  return {
    domain, width, left, right, lanesTop: LANES_TOP, lanesBottom, top, bottom, plotHeight: PLOT_HEIGHT,
    height: bottom + DATE_AXIS_HEIGHT,
    markerTop: laneCount ? lanesBottom + 6 : top,
    dayWidth: ((right - left) * DAY_MS) / span,
    xOf: (t) => left + ((t - domain[0]) / span) * (right - left),
    clampX: (x) => Math.min(right, Math.max(left, x)),
  };
}

// before or after when the day falls in the marker's two 7-day windows, else outside.
function dayBarKind(t, win) {
  if (!win || t < win.t - WEEK_MS || t >= win.t + WEEK_MS) return 'outside';
  return t >= win.t ? 'after' : 'before';
}

// Faint shade over each Saturday and Sunday, from the top of the lanes to the baseline.
function drawWeekends(svg, g) {
  for (const t of domainDays(g.domain)) {
    const day = new Date(t).getDay();
    if (day !== 0 && day !== 6) continue;
    const x0 = g.clampX(g.xOf(t - DAY_MS / 2));
    const x1 = g.clampX(g.xOf(t + DAY_MS / 2));
    svg.appendChild(svgEl('rect', { class: 'weekend-shade', x: x0, y: g.lanesTop, width: x1 - x0, height: g.bottom - g.lanesTop }));
  }
}

function drawWindowShade(svg, win, g) {
  const b0 = g.clampX(g.xOf(win.t - WEEK_MS));
  const mid = g.clampX(g.xOf(win.t));
  const a1 = g.clampX(g.xOf(win.t + WEEK_MS));
  svg.appendChild(svgEl('rect', { class: 'window-before', x: b0, y: g.top, width: mid - b0, height: g.plotHeight }));
  svg.appendChild(svgEl('rect', { class: 'window-after', x: mid, y: g.top, width: a1 - mid, height: g.plotHeight }));
}

// Before-window bars are hatched, after-window bars solid amber, the rest --border.
// A hatched bar's fill is an attribute, so css/setup-changes.css has no fill rule for .day-bar.before.
function drawDayBars(svg, days, row, win, g, dim) {
  const barWidth = Math.max(g.dayWidth * 0.64, 2);
  for (const d of days) {
    const t = dayNoon(d.date);
    const kind = dayBarKind(t, win);
    const h = Math.max((Math.min(d.value, g.max) / g.max) * g.plotHeight, 1);
    const rect = svgEl('rect', { class: `day-bar ${kind}${dim ? ' dimmed' : ''}`, x: g.xOf(t) - barWidth / 2, y: g.bottom - h, width: barWidth, height: h, rx: 1 });
    if (kind === 'before') rect.setAttribute('fill', fillFor(PATTERN_SCOPE, 'diag', BEFORE_INK));
    svg.appendChild(withTooltip(rect, `<strong>${shortDate(d.date)}</strong><br>${escapeHtml(row.fmt(d.value))}<br>${d.n} ${d.n === 1 ? row.unitOne : row.unit}`));
  }
}

// A day with no value gets a short dash on the baseline, so a gap reads as "nothing to
// count" and not as a missing bar.
function drawEmptyDays(svg, days, g) {
  const have = new Set(days.map((d) => d.date));
  for (const t of domainDays(g.domain)) {
    if (have.has(localDateStr(new Date(t)))) continue;
    const x = g.xOf(t);
    svg.appendChild(svgEl('line', { class: 'empty-dash', x1: x - 4, x2: x + 4, y1: g.bottom - 3, y2: g.bottom - 3 }));
  }
}

// One median as a line across its window with its value at the line's near end:
// "before 40.0k" at the left end, "after 50.0k" at the right end. A null median
// draws nothing.
function drawMedian(svg, g, row, { from, to, value, name }) {
  if (value == null) return;
  const x1 = g.clampX(g.xOf(from));
  const x2 = g.clampX(g.xOf(to));
  const y = g.yOf(value);
  svg.appendChild(svgEl('line', { class: `window-median ${name}`, x1, x2, y1: y, y2: y }));
  const atStart = name === 'before';
  const label = svgEl('text', { class: `median-label ${name}`, x: atStart ? x1 + 4 : x2 - 4, y: y - 5, 'text-anchor': atStart ? 'start' : 'end' });
  label.textContent = `${name} ${row.fmt(value)}`;
  svg.appendChild(label);
}

// The amber line at the change's time, from the window bar down to the plot's base.
// A row with no data draws it too, from drawMetricChart.
function drawChangeLine(svg, win, g) {
  svg.appendChild(svgEl('line', { class: 'marker-line', x1: g.xOf(win.t), x2: g.xOf(win.t), y1: g.markerTop, y2: g.bottom }));
}

// The two medians. They need the y scale, so they draw inside drawPlot.
function drawWindowLines(svg, win, row, g) {
  drawMedian(svg, g, row, { from: win.t - WEEK_MS, to: win.t, value: win.before, name: 'before' });
  drawMedian(svg, g, row, { from: win.t, to: win.t + WEEK_MS, value: win.after, name: 'after' });
}

// The y of a value in the daily plot. Values above max draw at the top. A negative
// value draws on the baseline: rtk's share kept out of context goes below zero on a
// day when rtk's output put more into context than it kept out. The table and the
// tooltip still show the real value.
export function plotY(value, { bottom, plotHeight, max }) {
  return bottom - (Math.min(Math.max(value, 0), max) / max) * plotHeight;
}

// The y axis, bars, session dots, medians and baseline for one row. Dots draw over
// dimmed bars and under the median lines.
function drawPlot(svg, days, row, win, layout, report) {
  const inView = sessionsInView(report, layout.domain);
  const dots = row.key === 'sessionStart' && inView.length > 0;
  const max = drawPlotAxis(svg, plotRawMax(row, days, win, inView), { ...layout, format: row.axis });
  const g = { ...layout, max, yOf: (v) => plotY(v, { bottom: layout.bottom, plotHeight: layout.plotHeight, max }) };
  if (win) drawWindowShade(svg, win, g);
  drawDayBars(svg, days, row, win, g, dots);
  drawEmptyDays(svg, days, g);
  if (dots) drawSessionDots(svg, report, g);
  if (win) {
    drawWindowLines(svg, win, row, g);
    drawChangeLine(svg, win, g);
  }
  svg.appendChild(svgEl('line', { x1: g.left, x2: g.right, y1: g.bottom, y2: g.bottom, stroke: 'var(--border)' }));
}

// "Oct 1" for the first label and for the 1st of a month, else the day number.
function dateLabel(t, first) {
  const d = new Date(t);
  if (!first && d.getDate() !== 1) return String(d.getDate());
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

// Every day while a day is 28px wide (dateLabelStep), Mondays below that. The picked
// change's day is bold amber (.axis-label.picked).
function drawDateAxis(svg, g, marker) {
  const step = dateLabelStep(g.dayWidth);
  const pickedDay = marker ? localDateStr(new Date(marker.t)) : null;
  let first = true;
  for (const t of domainDays(g.domain)) {
    if (step === 'monday' && new Date(t).getDay() !== 1) continue;
    const picked = localDateStr(new Date(t)) === pickedDay;
    const label = svgEl('text', { class: picked ? 'axis-label picked' : 'axis-label', x: g.xOf(t), y: g.bottom + 14, 'text-anchor': 'middle' });
    label.textContent = dateLabel(t, first);
    first = false;
    svg.appendChild(label);
  }
}

function laneY(g, laneIndex) {
  return g.lanesTop + laneIndex * LANE_HEIGHT + LANE_HEIGHT / 2;
}

// The gutter text for each lane and a faint rule under it.
function drawLaneRows(svg, kinds, g) {
  kinds.forEach((kind, i) => {
    const y = laneY(g, i);
    svg.appendChild(markerGlyph(kind, 10, y));
    const name = svgEl('text', { class: 'lane-name', x: 22, y: y + 3.5 });
    name.textContent = MARKER_KIND_NAMES[kind] || kind;
    svg.appendChild(name);
    svg.appendChild(svgEl('line', { class: 'lane-rule', x1: g.left, x2: g.right, y1: y + LANE_HEIGHT / 2, y2: y + LANE_HEIGHT / 2 }));
  });
}

// Amber outline and tint over the picked change's day, across every lane.
function drawPickedColumn(svg, marker, g) {
  if (!marker || marker.t < g.domain[0] || marker.t > g.domain[1]) return;
  const x0 = g.clampX(g.xOf(localMidnight(marker.t)));
  const x1 = g.clampX(g.xOf(localMidnight(marker.t)) + g.dayWidth);
  svg.appendChild(svgEl('rect', {
    class: 'lane-picked', x: x0, y: g.lanesTop - 3,
    width: Math.max(x1 - x0, 4), height: g.lanesBottom - g.lanesTop + 6, rx: 3,
  }));
}

function cellLabel(cell) {
  const weekly = cell.end - cell.start > 2 * DAY_MS;
  const day = new Date(cell.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const n = cell.markers.length;
  return `${weekly ? 'Week of ' : ''}${day}, ${MARKER_KIND_NAMES[cell.kind]}, ${n} change${n === 1 ? '' : 's'}`;
}

// One line per change: time, glyph, label.
function cellTooltip(cell) {
  return cell.markers.map((m) => `${escapeHtml(markerDate(m.t))} ${markerIcon(m.kind).outerHTML} ${escapeHtml(m.label)}`).join('<br>');
}

// A focusable cell: the glyph at the centre of its day or week, a count beside it when
// it holds more than one change, and a hit area as wide as the cell. A week at the edge
// of the domain centres on the part inside the domain.
function laneCellNode(cell, laneIndex, g, pickedKey, onPick) {
  const lo = Math.max(cell.start, g.domain[0]);
  const hi = Math.min(cell.end, g.domain[1]);
  const many = cell.markers.length > 1;
  const cx = g.xOf((lo + hi) / 2) - (many ? 4 : 0);
  const y = laneY(g, laneIndex);
  const picked = cell.markers.some((m) => markerKey(m) === pickedKey);
  const node = svgEl('g', {
    class: picked ? 'lane-cell picked' : 'lane-cell', tabindex: 0, role: 'button',
    'aria-label': cellLabel(cell), 'aria-pressed': String(picked), 'data-name': `${cell.kind}|${cell.start}`,
  });
  node.appendChild(svgEl('rect', { class: 'lane-hit', x: g.xOf(lo), y: y - LANE_HEIGHT / 2, width: g.xOf(hi) - g.xOf(lo), height: LANE_HEIGHT }));
  node.appendChild(markerGlyph(cell.kind, cx, y));
  if (many) {
    const count = svgEl('text', { class: 'lane-count', x: cx + 7, y: y + 3.5 });
    count.textContent = String(cell.markers.length);
    node.appendChild(count);
  }
  const pick = () => onPick(pickInCell(cell));
  node.addEventListener('click', pick);
  node.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    evt.preventDefault();
    pick();
  });
  const html = cellTooltip(cell);
  return withFocusTooltip(withTooltip(node, html), html);
}

// The lanes: gutter names, the picked day's column, then one cell per kind per day.
function drawChangeLanes(svg, lanes, marker, g, onPick) {
  drawLaneRows(svg, lanes.kinds, g);
  drawPickedColumn(svg, marker, g);
  const pickedKey = marker ? markerKey(marker) : null;
  for (const cell of lanes.cells) {
    svg.appendChild(laneCellNode(cell, lanes.kinds.indexOf(cell.kind), g, pickedKey, onPick));
  }
}

// Hatched from 7 days before the change to the change, solid amber from the change
// to 7 days after or to now, whichever is earlier. The bar sits under the lanes.
function drawWindowBar(svg, win, g, now) {
  const y = g.lanesBottom + 10;
  const a = g.clampX(g.xOf(win.t - WEEK_MS));
  const b = g.clampX(g.xOf(win.t));
  const c = g.clampX(g.xOf(Math.min(win.t + WEEK_MS, now)));
  svg.appendChild(svgEl('rect', { class: 'window-bar before', x: a, y, width: b - a, height: 6, fill: fillFor(PATTERN_SCOPE, 'diag', BEFORE_INK) }));
  svg.appendChild(svgEl('rect', { class: 'window-bar after', x: b, y, width: Math.max(c - b, 0), height: 6 }));
}

// The lane kinds and cells for the markers inside the domain. The cell size depends
// on the day width the plot will have.
function laneModel(markers, domain, width) {
  const inView = markersInDomain(markers, domain);
  const dayWidth = ((width - RIGHT_PAD - PLOT_LEFT) * DAY_MS) / (domain[1] - domain[0]);
  return { kinds: laneKinds(inView), cells: laneCells(inView, domain, dayWidth) };
}

function drawNoData(svg, row, g) {
  const text = svgEl('text', { class: 'plot-empty', x: (g.left + g.right) / 2, y: (g.top + g.bottom) / 2, 'text-anchor': 'middle' });
  text.textContent = `No data for ${row.name} in this range.`;
  svg.appendChild(text);
}

// Lanes, window bar, daily chart and date axis in one SVG on one x scale. A row with
// no data in the domain still draws the lanes, with a note in the plot area.
export function drawMetricChart(container, report, marker, row, domain, onPick) {
  hideTooltip();
  container.innerHTML = '';
  const width = chartWidth(container);
  const lanes = laneModel(report.markers, domain, width);
  const layout = plotLayout(domain, width, lanes.kinds.length);
  const days = daysInDomain(report, row, domain);
  const win = markerWindow(marker, row, domain);
  const svg = svgEl('svg', { viewBox: `0 0 ${layout.width} ${layout.height}`, height: layout.height, class: 'changes-chart' });
  appendPatternDefs(svg, PATTERN_SCOPE, [{ texture: 'diag', color: BEFORE_INK }]);
  drawWeekends(svg, layout);
  drawChangeLanes(svg, lanes, marker, layout, onPick);
  if (win) drawWindowBar(svg, win, layout, Date.now());
  if (days.length) drawPlot(svg, days, row, win, layout, report);
  else {
    drawNoData(svg, row, layout);
    if (win) drawChangeLine(svg, win, layout);
  }
  drawDateAxis(svg, layout, marker);
  container.appendChild(svg);
}

// Row one: the three windows. Each icon is the window's bar fill with its median
// rule across it. Row two, on the Session start row: one dot shape per model that
// has a session in view.
export function drawMetricLegend(legend, row, report, domain) {
  const windowIcon = (kind, background) =>
    el('span', { class: `legend-swatch window-swatch ${kind}`, style: `background:${background}`, 'aria-hidden': 'true' });
  const rows = [legendRow([
    { icon: windowIcon('before', textureCss('diag', BEFORE_INK)), label: 'before', title: '7 days before the picked change: bars, with the median dashed' },
    { icon: windowIcon('after', 'var(--accent-cyan)'), label: 'after', title: '7 days after the picked change: bars, with the median solid' },
    { icon: windowIcon('outside', 'var(--border)'), label: 'outside', title: 'Days outside both windows' },
  ], 'changes-legend')];
  const inView = sessionsInView(report, domain);
  if (row.key === 'sessionStart' && inView.length) rows.push(dotLegendRow(report, inView));
  legend.replaceChildren(...rows);
}

function dotLegendRow(report, inView) {
  const shapes = modelShapes(report.sessions);
  const items = [...new Set(inView.map((s) => s.model))].map((model) => {
    const icon = svgEl('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' });
    icon.appendChild(sessionDot(shapes.get(model), 5, 5));
    return { icon, label: model ? modelLabel(model) : 'unknown model', title: model || 'unknown model' };
  });
  const row = legendRow(items, 'changes-legend');
  row.prepend(el('span', { class: 'legend-lead', text: 'sessions:' }));
  return row;
}
