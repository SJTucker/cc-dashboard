// The Setup changes charts: context at session start with the change markers,
// and the daily chart beside the before/after table. Both share one time axis.
import { el, svgEl, hideTooltip, chartWidth, withTooltip, withFocusTooltip } from '../dom.mjs';
import { formatTokens, shortDate, localDateStr, axisTokens, escapeHtml } from '../format.mjs';
import { CHART_HEIGHT, CHART_PAD_LEFT, CHART_PAD_BOTTOM, drawYAxis, drawPlotAxis } from './axes.mjs';
import { appendPatternDefs, fillFor, textureCss } from './palette.mjs';

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
  config: 'config', effort: 'effort', model: 'model', 'claude-code': 'Claude Code update', other: 'other',
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

export function markerDate(t) {
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Local midnight on the Monday of t's week.
function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function dayNoon(dateKey) {
  return new Date(`${dateKey}T12:00`).getTime();
}

// Both charts share one time axis so a marker sits at the same x in each. This is
// the all-history axis; chartDomain narrows it to the range picker. Built from
// sessions and the daily series named by keys (the transcript rows of the
// before/after table) only. Markers and rtk days are left out. Claude Code
// deletes transcripts after cleanupPeriodDays (30 by default), so history has a
// sliding start, while rtk keeps every row. A marker or an rtk day from before
// the earliest surviving transcript would stretch the axis with an empty strip on
// one side. Markers outside the resulting domain are filtered out where each
// chart draws them (see markerInDomain below), and rtk days in drawMetricChart.
export function timeDomain(report, keys) {
  const times = [
    ...report.sessions.map((s) => s.t),
    ...keys.flatMap((key) => report.daily[key].map((d) => dayNoon(d.date))),
  ];
  return [Math.min(...times) - DAY_MS / 2, Math.max(...times) + DAY_MS / 2];
}

// True when a marker falls inside the time axis both charts share. A marker just
// outside it (see timeDomain above) keeps its place in the marker button list but
// draws no glyph, guide, line or shaded window on either chart.
function markerInDomain(marker, domain) {
  return Boolean(marker) && marker.t >= domain[0] && marker.t <= domain[1];
}

function timeScale(domain, width) {
  return (t) => CHART_PAD_LEFT + ((t - domain[0]) / (domain[1] - domain[0])) * (width - CHART_PAD_LEFT);
}

// One label per Monday.
function drawTimeAxis(svg, domain, xOf) {
  const d = new Date(domain[0]);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
  for (; d.getTime() <= domain[1]; d.setDate(d.getDate() + 7)) {
    const label = svgEl('text', { class: 'axis-label', x: xOf(d.getTime()), y: CHART_HEIGHT - 4, 'text-anchor': 'middle' });
    label.textContent = shortDate(localDateStr(d));
    svg.appendChild(label);
  }
}

const MARKER_SOURCES = {
  file: 'from changes.json',
  plugin: 'detected from the plugin list',
  model: 'detected from transcripts',
  update: 'from the Claude Code changelog',
  auto: 'recorded by the mod',
};

function markerTooltip(m) {
  const source = MARKER_SOURCES[m.source] || 'detected from transcripts';
  return `<strong>${escapeHtml(markerDate(m.t))}</strong><br>${escapeHtml(m.label)}<br>${escapeHtml(source)}`;
}

function modelShapes(sessions) {
  const counts = new Map();
  for (const s of sessions) counts.set(s.model, (counts.get(s.model) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  return new Map(ranked.map((model, i) => [model, DOT_SHAPES[Math.min(i, DOT_SHAPES.length - 1)]]));
}

function drawWeeklyMedian(svg, sessions, domain, xOf, yOf) {
  const weeks = new Map();
  for (const s of sessions) {
    const w = weekStart(s.t);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(s.context);
  }
  let d = '';
  for (const [w, values] of [...weeks].sort((a, b) => a[0] - b[0])) {
    // The median uses every session of the week, so it does not change with the range.
    if (w + WEEK_MS <= domain[0]) continue;
    const x1 = xOf(Math.max(w, domain[0]));
    const x2 = xOf(Math.min(w + WEEK_MS, domain[1]));
    const y = yOf(median(values));
    d += `${d ? 'L' : 'M'}${x1},${y} L${x2},${y} `;
    const label = svgEl('text', { class: 'step-label', x: (x1 + x2) / 2, y: y - 6, 'text-anchor': 'middle' });
    label.textContent = axisTokens(Math.round(median(values)));
    svg.appendChild(label);
  }
  svg.appendChild(svgEl('path', { class: 'step-line', d }));
}

// Real value stays in the tooltip even for a dot clamped to the top edge below -
// only its position is capped at the 95th-percentile axis max, not the number shown.
function sessionTooltip(s, max) {
  const offScale = s.context > max ? ' (off the top of the scale)' : '';
  return `<strong>${escapeHtml(markerDate(s.t))}</strong><br>${formatTokens(s.context)} tokens at the first call${offScale}<br>${escapeHtml(s.model || 'unknown model')}`;
}

export function drawSessionStartChart(container, legend, report, domain) {
  hideTooltip();
  container.innerHTML = '';
  const { sessions, markers } = report;
  if (!sessions.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No sessions yet.' }));
    return;
  }
  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const xOf = timeScale(domain, width);
  const inView = sessions.filter((s) => s.t >= domain[0] && s.t <= domain[1]);
  const visibleMarkers = markers.filter((m) => markerInDomain(m, domain));

  // A glyph closer than 12px to the one before it stacks one row lower. A stack of
  // more than 5 shows 5 glyphs and a +n for the rest.
  const stack = stackGlyphs(visibleMarkers.map((m) => xOf(m.t)));
  const rows = Math.max(stack.rows, 1);
  const railTop = CHART_HEIGHT + 12;
  const height = railTop + rows * 13;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, class: 'changes-chart' });
  // The 95th percentile, not the max: one outlier session (a 260,620-token session
  // measured against a typical 38k-52k) otherwise sets the axis top and squashes
  // every ordinary session into the bottom slice of the plot. A dot above the
  // percentile still draws, clamped to the top edge by yOf below.
  const max = drawYAxis(svg, percentile((inView.length ? inView : sessions).map((s) => s.context), 95), width, axisTokens);
  const yOf = (v) => plotHeight - (Math.min(v, max) / max) * plotHeight;
  svg.appendChild(svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)' }));
  drawTimeAxis(svg, domain, xOf);

  visibleMarkers.forEach((m, i) => {
    const x = xOf(m.t);
    svg.appendChild(svgEl('line', { class: 'marker-guide', x1: x, x2: x, y1: 0, y2: plotHeight }));
    const { row, hidden } = stack.glyphs[i];
    if (!hidden) svg.appendChild(withTooltip(markerGlyph(m.kind, x, railTop + row * 13), markerTooltip(m)));
  });
  for (const o of stack.overflows) {
    const hiddenMarkers = o.indices.map((i) => visibleMarkers[i]);
    const label = svgEl('text', { class: 'marker-overflow', x: o.x, y: railTop + o.row * 13 + 4, 'text-anchor': 'middle', tabindex: 0 });
    label.textContent = `+${hiddenMarkers.length}`;
    const lines = hiddenMarkers.map((m) => `${markerDate(m.t)} · ${m.label} · ${MARKER_SOURCES[m.source] || 'detected from transcripts'}`);
    label.setAttribute('aria-label', `${hiddenMarkers.length} more changes: ${lines.join('; ')}`);
    const html = lines.map(escapeHtml).join('<br>');
    svg.appendChild(withFocusTooltip(withTooltip(label, html), html));
  }

  const shapes = modelShapes(sessions); // shapes stay the same on every range
  for (const s of inView) {
    const dot = sessionDot(shapes.get(s.model), xOf(s.t), yOf(s.context));
    svg.appendChild(withTooltip(dot, sessionTooltip(s, max)));
  }
  drawWeeklyMedian(svg, sessions, domain, xOf, yOf);
  container.appendChild(svg);

  legend.replaceChildren();
  for (const [model, shape] of shapes) {
    const icon = svgEl('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' });
    icon.appendChild(sessionDot(shape, 5, 5));
    legend.appendChild(el('span', { class: 'legend-item' }, [icon, document.createTextNode(model || 'unknown model')]));
  }
  legend.appendChild(el('span', { class: 'legend-item' }, [el('span', { class: 'legend-line step-swatch' }), document.createTextNode('weekly median')]));
  for (const kind of new Set(visibleMarkers.map((m) => m.kind))) {
    legend.appendChild(el('span', { class: 'legend-item' }, [markerIcon(kind), document.createTextNode(MARKER_KIND_NAMES[kind] || kind)]));
  }
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

// The before-window bars and the legend swatch use this ink. It equals --text-secondary
// in style.css. A pattern's paint cannot be a CSS variable, so the hex is repeated here.
const BEFORE_INK = '#7f93b8';
const PATTERN_SCOPE = 'ba';

// Where the plot starts. Task 3 widens it to the lane gutter.
const PLOT_LEFT = CHART_PAD_LEFT;
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
// A hatched bar's fill is an attribute, so style.css has no fill rule for .day-bar.before.
function drawDayBars(svg, days, row, win, g) {
  const barWidth = Math.max(g.dayWidth * 0.64, 2);
  for (const d of days) {
    const t = dayNoon(d.date);
    const kind = dayBarKind(t, win);
    const h = Math.max((Math.min(d.value, g.max) / g.max) * g.plotHeight, 1);
    const rect = svgEl('rect', { class: `day-bar ${kind}`, x: g.xOf(t) - barWidth / 2, y: g.bottom - h, width: barWidth, height: h, rx: 1 });
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

// The two medians and the amber line at the change's time.
function drawWindowLines(svg, win, row, g) {
  drawMedian(svg, g, row, { from: win.t - WEEK_MS, to: win.t, value: win.before, name: 'before' });
  drawMedian(svg, g, row, { from: win.t, to: win.t + WEEK_MS, value: win.after, name: 'after' });
  svg.appendChild(svgEl('line', { class: 'marker-line', x1: g.xOf(win.t), x2: g.xOf(win.t), y1: g.markerTop, y2: g.bottom }));
}

// The y axis, bars, medians and baseline for one row. The 7-day lines can sit above
// every bar, so the axis has to reach them too.
function drawPlot(svg, days, row, win, layout) {
  const lines = win ? [win.before, win.after].filter((v) => v != null) : [];
  const rawMax = Math.max(...days.map((d) => d.value), ...lines);
  const max = drawPlotAxis(svg, rawMax, { ...layout, format: row.axis });
  const g = { ...layout, max, yOf: (v) => layout.bottom - (Math.min(v, max) / max) * layout.plotHeight };
  if (win) drawWindowShade(svg, win, g);
  drawDayBars(svg, days, row, win, g);
  drawEmptyDays(svg, days, g);
  if (win) drawWindowLines(svg, win, row, g);
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

// The daily chart for the row the reader picked, over the shared time axis domain.
export function drawMetricChart(container, report, marker, row, domain) {
  hideTooltip();
  container.innerHTML = '';
  const days = daysInDomain(report, row, domain);
  if (!days.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: `No data for ${row.name} yet.` }));
    return;
  }
  const layout = plotLayout(domain, chartWidth(container), 0);
  const svg = svgEl('svg', { viewBox: `0 0 ${layout.width} ${layout.height}`, height: layout.height, class: 'changes-chart' });
  appendPatternDefs(svg, PATTERN_SCOPE, [{ texture: 'diag', color: BEFORE_INK }]);
  drawWeekends(svg, layout);
  drawPlot(svg, days, row, markerWindow(marker, row, domain), layout);
  drawDateAxis(svg, layout, marker);
  container.appendChild(svg);
}

function legendItem(swatch, text) {
  return el('span', { class: 'legend-item' }, [swatch, document.createTextNode(text)]);
}

// One legend row under the chart. Hatch, fill, dash and solid line separate the five
// marks without colour.
export function drawMetricLegend(legend) {
  const box = (background) => el('span', { class: 'legend-swatch', style: `background:${background}` });
  const rule = (cls) => el('span', { class: `legend-line ${cls}` });
  legend.replaceChildren(el('div', { class: 'legend changes-legend' }, [
    legendItem(box(textureCss('diag', BEFORE_INK)), '7 days before'),
    legendItem(box('var(--accent-cost)'), '7 days after'),
    legendItem(box('var(--border)'), 'outside the windows'),
    legendItem(rule('median-before-swatch'), 'before median'),
    legendItem(rule('median-after-swatch'), 'after median'),
  ]));
}
