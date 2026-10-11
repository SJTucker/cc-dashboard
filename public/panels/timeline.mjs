// The Session timeline: one lane per session with activity today.
import { svgEl, withTooltip, hideTooltip, chartWidth } from '../dom.mjs';
import { formatCost, formatTokens, formatDuration, escapeHtml } from '../format.mjs';
import { appendPatternDefs, fillFor, TOKEN_SERIES } from '../charts/palette.mjs';
import { state } from '../state.mjs';
import { LIVE_WINDOW_MS } from '../constants.mjs';

// One lane per session that has activity today (laneLayout in
// public/chart-geometry.js), with a bar per span. A live session's bars are solid
// and, when its last call was within LIVE_WINDOW_MS, its last bar ends in an
// arrowhead at now. Every other session's bars carry the diagonal texture. The
// key in the p.panel-note under the chart (public/index.html) says so in words,
// so the two kinds never depend on colour. An SVG pattern needs a literal colour,
// so TIMELINE_COLOR repeats --accent-cyan from public/style.css.
const TIMELINE_COLOR = '#3fe0ff';
const TIMELINE_LANE_HEIGHT = 22;
const TIMELINE_BAR_HEIGHT = 10;
const TIMELINE_AXIS_HEIGHT = 20;
const TIMELINE_GUTTER = 200;
const TIMELINE_RIGHT_PAD = 10;
// A lane that a /clear started (follows in laneLayout) has its label indented by
// FOLLOW_INDENT px with a ↳ before its glyph, which together take FOLLOW_CHARS of the
// label's characters. Its curve from the replaced session's lane is TIMELINE_COLOR at
// LINK_OPACITY, with a LINK_DOT px dot at each end, and starts LINK_GAP px clear of
// each bar. An open bar's arrowhead is ARROW_PX wide.
const FOLLOW_INDENT = 12;
const FOLLOW_CHARS = 4;
const LINK_OPACITY = 0.55;
const LINK_DOT = 2;
const LINK_GAP = 3;
const ARROW_PX = 6;
// The Rebuilds column at the right: its heading row above the lanes, the gap between
// the plot and the column, and the narrowest plot that still gets the column. Below
// that width the column is left out and the header note carries the total.
const TIMELINE_HEAD_HEIGHT = 18;
const REBUILD_COLUMN_GAP = 16;
const REBUILD_COLUMN_MIN_PLOT = 160;
// Column text widths: 11px data font, and the 10px heading with its letter spacing.
const DATA_CHAR_PX = 6.6;
const HEAD_CHAR_PX = 6.5;

// Prompt-cache rebuild marks (rebuildMarks in public/chart-geometry.js). A mark is a
// diamond on the lane's bar line. A main-thread rebuild is filled with the Cache
// write series colour and outlined in --surface. A subagent's rebuild is filled
// with --surface and outlined in that colour, so it reads as hollow on a bar. The
// key under the chart says so in words, so the two never depend on colour.
const REBUILD_COLOR = TOKEN_SERIES.find((s) => s.key === 'cacheCreate').color;
const REBUILD_SURFACE = '#0b1222'; // --surface in public/style.css
const REBUILD_SIZE = 8;
const REBUILD_TOOLTIP_ITEMS = 5;

const REBUILD_CAUSES = {
  messages: 'earlier messages changed',
  tools: 'tool list changed',
  system: 'system prompt changed',
  model: 'model changed',
  unavailable: 'cache unavailable',
  unknown: 'cause unknown',
};

function causeText(r) {
  if (r.cause === 'expired') return `cache expired after ${formatDuration(r.gapMs)} idle`;
  if (r.cause === 'other') return `cache miss: ${r.reason}`;
  return REBUILD_CAUSES[r.cause] || REBUILD_CAUSES.unknown;
}

function rebuildLine(r) {
  const who = r.main ? 'Cache rebuild' : 'Subagent cache rebuild';
  // An unpriced model has no premium, and an amount of $0.00 would be wrong.
  const premium = r.premium == null ? '' : ` · +${formatCost(r.premium)} over a cache read`;
  return `<b>${who}</b> · ${clockTime(r.t)}<br>${escapeHtml(causeText(r))}<br>${formatTokens(r.tokens)} tokens rewritten${premium}`;
}

function rebuildTooltip(mark) {
  if (mark.items.length === 1) return rebuildLine(mark.items[0]);
  const shown = mark.items.slice(0, REBUILD_TOOLTIP_ITEMS).map(rebuildLine);
  const more = mark.items.length - shown.length;
  const moreLine = more > 0 ? `<br>and ${more} more` : '';
  // Unpriced rebuilds have no premium. With none priced there is no total to show.
  const { premium } = rebuildTotals(mark.items);
  const totalLine = premium === null ? '' : `<br><br>Total +${formatCost(premium)}`;
  return `<b>${mark.items.length} cache rebuilds</b><br><br>${shown.join('<br><br>')}${moreLine}${totalLine}`;
}

// One lane's rebuild marks, drawn over its bars. A mark of two or more rebuilds has
// its count to the right of the diamond.
function drawRebuilds(svg, rebuilds, xOf, mid) {
  const h = REBUILD_SIZE / 2;
  for (const mark of rebuildMarks(rebuilds, xOf, REBUILD_SIZE)) {
    const { x } = mark;
    svg.appendChild(withTooltip(svgEl('path', {
      class: 'timeline-rebuild',
      d: `M${x},${mid - h} L${x + h},${mid} L${x},${mid + h} L${x - h},${mid} Z`,
      fill: mark.main ? REBUILD_COLOR : REBUILD_SURFACE,
      stroke: mark.main ? REBUILD_SURFACE : REBUILD_COLOR,
      'stroke-width': mark.main ? 1 : 1.5,
    }), rebuildTooltip(mark)));
    if (mark.items.length < 2) continue;
    const count = svgEl('text', { class: 'timeline-rebuild-count', x: x + h + 2, y: mid - 2 });
    count.textContent = String(mark.items.length);
    svg.appendChild(count);
  }
}

// The redraw tears down the SVG, which would kill an open tooltip, so an unchanged
// payload within the same minute and width skips it. The minute is in the signature
// because the "now" line and the open bars move with the clock.
let timelineSignature = null;

// Forgets the last signature, so the next renderTimeline draws. redrawCharts and
// reportDrawError call it.
export function resetTimeline() {
  timelineSignature = null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function cutLabel(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timelineTooltip(s, bar) {
  const name = s.title || s.project || '—';
  // With a title, the line under it is project · branch. Without one the project is
  // already the name, so the line is the branch alone.
  const context = (s.title ? [s.project, s.branch] : [s.branch]).filter(Boolean);
  const contextHtml = context.length ? `${context.map(escapeHtml).join(' · ')}<br>` : '';
  const range = bar.start === bar.end ? clockTime(bar.start) : `${clockTime(bar.start)} – ${clockTime(bar.end)}`;
  return `<b>${escapeHtml(name)}</b><br>${contextHtml}${range}<br>${formatCost(s.costTodayUsd)} today · ${plural(s.prompts, 'prompt', 'prompts')}`;
}

function timelineKey(live, width, now) {
  return JSON.stringify([
    width,
    Math.floor(now / 60_000),
    live.sessions.map((s) => [s.sessionId, s.clearedFrom, s.spans, s.live, s.title, s.titleSource, s.project, s.branch, s.costTodayUsd, s.prompts, s.rebuilds]),
  ]);
}

// A gridline per hour tick, with a label on every step-th one.
function drawHourGrid(svg, ticks, { xOf, width, gutter, top, plotHeight, height }) {
  const step = labelStep(ticks.length, width - gutter);
  ticks.forEach((t, i) => {
    svg.appendChild(svgEl('line', { x1: xOf(t), x2: xOf(t), y1: top, y2: top + plotHeight, stroke: 'var(--border)', 'stroke-width': 1 }));
    if (i % step !== 0) return;
    const label = svgEl('text', { class: 'axis-label', x: xOf(t), y: height - 4, 'text-anchor': 'middle' });
    label.textContent = `${String(new Date(t).getHours()).padStart(2, '0')}:00`;
    svg.appendChild(label);
  });
}

// The Rebuilds column's layout, or null when no session has a rebuild or the plot
// would get narrower than REBUILD_COLUMN_MIN_PLOT. Each row shows the rebuild mark and
// count right-aligned at countRight, and the premium right-aligned at the edge.
function rebuildColumn(sessions, width, gutter) {
  const rows = sessions.map((s) => rebuildTotals(s.rebuilds)).filter((t) => t.count);
  if (!rows.length) return null;
  const countChars = Math.max(...rows.map((t) => `◆ ${t.count}`.length));
  const costChars = Math.max(0, ...rows.map((t) => (t.premium === null ? 0 : `+${formatCost(t.premium)}`.length)));
  const costWidth = Math.ceil(costChars * DATA_CHAR_PX);
  const rowWidth = Math.ceil(countChars * DATA_CHAR_PX) + (costWidth ? 10 + costWidth : 0);
  const columnWidth = Math.max(rowWidth, Math.ceil('REBUILDS'.length * HEAD_CHAR_PX));
  const plotRight = width - TIMELINE_RIGHT_PAD - columnWidth - REBUILD_COLUMN_GAP;
  if (plotRight - gutter < REBUILD_COLUMN_MIN_PLOT) return null;
  return { plotRight, countRight: costWidth ? width - costWidth - 10 : width };
}

// One row of the Rebuilds column: a filled diamond when any rebuild was the main
// session's, a hollow one when all were subagents', then the count and the premium.
function drawRebuildCell(svg, rebuilds, column, width, mid) {
  const totals = rebuildTotals(rebuilds);
  if (!totals.count) return;
  const anyMain = rebuilds.some((r) => r.main !== false);
  const what = plural(totals.count, anyMain ? 'cache rebuild' : 'subagent cache rebuild', anyMain ? 'cache rebuilds' : 'subagent cache rebuilds');
  const tipText = totals.premium === null ? what : `${what}, +${formatCost(totals.premium)} over cache reads`;
  const tip = () => { const t = svgEl('title', {}); t.textContent = tipText; return t; };

  const count = svgEl('text', { class: 'timeline-rebuild-cell', x: column.countRight, y: mid + 4, 'text-anchor': 'end' });
  const mark = svgEl('tspan', { fill: REBUILD_COLOR, 'aria-hidden': 'true' });
  mark.textContent = anyMain ? '◆' : '◇';
  count.append(mark, ` ${totals.count}`, tip());
  svg.appendChild(count);
  if (totals.premium === null) return;
  const cost = svgEl('text', { class: 'timeline-rebuild-cell', x: width, y: mid + 4, 'text-anchor': 'end' });
  cost.append(`+${formatCost(totals.premium)}`, tip());
  svg.appendChild(cost);
}

const laneMid = (top, lane) => top + lane * TIMELINE_LANE_HEIGHT + TIMELINE_LANE_HEIGHT / 2;

// The curve from the end of the replaced session's last bar to the start of this
// lane's first bar (linkPath in public/chart-geometry.js), with a dot at each end.
// drawTimeline draws every link before the lanes, so bars sit on top of the curves.
function drawLink(svg, { lane, bars, follows }, top) {
  const last = follows.bars[follows.bars.length - 1];
  const x1 = last.x + last.width + (last.open ? ARROW_PX : 0) + LINK_GAP;
  const y1 = laneMid(top, follows.lane);
  const x2 = bars[0].x - LINK_GAP;
  const y2 = laneMid(top, lane);
  const path = svgEl('path', {
    class: 'timeline-link', d: linkPath(x1, y1, x2, y2), fill: 'none',
    stroke: TIMELINE_COLOR, 'stroke-opacity': LINK_OPACITY, 'stroke-width': 1.25,
  });
  const tip = svgEl('title', {});
  tip.textContent = 'Started by /clear in this session';
  path.appendChild(tip);
  svg.appendChild(path);
  for (const [cx, cy] of [[x1, y1], [x2, y2]]) {
    svg.appendChild(svgEl('circle', { class: 'timeline-link-end', cx, cy, r: LINK_DOT, fill: TIMELINE_COLOR }));
  }
}

// One session's label in the gutter, its bars and its Rebuilds cell. A lane a /clear
// started has its label indented, with a ↳ before the glyph.
function drawLane(svg, { session: s, lane, bars, follows }, maxChars, xOf, { top, column, width }) {
  const mid = laneMid(top, lane);
  const label = svgEl('text', { class: 'timeline-label', x: follows ? FOLLOW_INDENT : 0, y: mid + 4 });
  if (s.titleSource === 'prompt') label.classList.add('prompt-title');
  const fullName = s.title || s.project || '—';
  if (follows) {
    const arrow = svgEl('tspan', { class: 'timeline-follow', 'aria-hidden': 'true' });
    arrow.textContent = '↳ ';
    label.appendChild(arrow);
  }
  const glyph = svgEl('tspan', { 'aria-hidden': 'true' });
  glyph.textContent = s.live ? '⬢' : '⬡';
  const name = svgEl('title', {});
  name.textContent = fullName;
  label.append(glyph, ` ${cutLabel(fullName, follows ? maxChars - FOLLOW_CHARS : maxChars)}`, name);
  svg.appendChild(label);

  const fill = fillFor('timeline', s.live ? 'solid' : 'diag', TIMELINE_COLOR);
  const y = mid - TIMELINE_BAR_HEIGHT / 2;
  for (const bar of bars) {
    // laneLayout's 3px minimum shows half of the 6px diagonal texture tile.
    if (!s.live) bar.width = Math.max(6, bar.width);
    svg.appendChild(withTooltip(svgEl('rect', {
      class: 'timeline-bar', x: bar.x, y, width: bar.width, height: TIMELINE_BAR_HEIGHT, rx: 3, fill,
    }), timelineTooltip(s, bar)));
    if (bar.open) {
      const tip = bar.x + bar.width;
      svg.appendChild(svgEl('path', {
        class: 'timeline-arrow', d: `M${tip},${y - 1} L${tip + 6},${mid} L${tip},${y + TIMELINE_BAR_HEIGHT + 1} Z`, fill: TIMELINE_COLOR,
      }));
    }
  }
  // A server started before rebuilds existed sends none. public/ is read from disk
  // on each request, so this page can meet that server.
  drawRebuilds(svg, s.rebuilds || [], xOf, mid);
  if (column) drawRebuildCell(svg, s.rebuilds || [], column, width, mid);
}

// Draws the lanes into container. Returns the number of lanes, of live lanes, and
// whether the Rebuilds column was drawn.
function drawTimeline(container, sessions, width, now) {
  const starts = sessions.flatMap((s) => s.spans.map((span) => span[0]));
  const ticks = hourTicks(Math.min(...starts), now);
  const domain = [ticks[0], ticks[ticks.length - 1]];
  const gutter = Math.min(TIMELINE_GUTTER, Math.round(width * 0.4));
  const column = rebuildColumn(sessions, width, gutter);
  const plotRight = column ? column.plotRight : width - TIMELINE_RIGHT_PAD;
  const top = column ? TIMELINE_HEAD_HEIGHT : 0;
  const xOf = (t) => gutter + ((t - domain[0]) / (domain[1] - domain[0])) * (plotRight - gutter);
  const lanes = laneLayout(sessions, xOf, now, 3, LIVE_WINDOW_MS);
  const plotHeight = lanes.length * TIMELINE_LANE_HEIGHT;
  const height = top + plotHeight + TIMELINE_AXIS_HEIGHT;
  const liveLanes = lanes.filter((l) => l.session.live).length;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: 'img',
    'aria-label': `Session timeline: ${plural(lanes.length, 'session', 'sessions')} today, ${liveLanes} live`,
  });
  appendPatternDefs(svg, 'timeline', [{ texture: 'diag', color: TIMELINE_COLOR }]);
  drawHourGrid(svg, ticks, { xOf, width: plotRight + TIMELINE_RIGHT_PAD, gutter, top, plotHeight, height });
  if (column) {
    const head = svgEl('text', { class: 'timeline-column-head', x: width, y: TIMELINE_HEAD_HEIGHT - 6, 'text-anchor': 'end' });
    head.textContent = 'REBUILDS';
    svg.appendChild(head);
  }
  const maxChars = Math.floor((gutter - 8 - 14) / 6.6);
  for (const lane of lanes) if (lane.follows) drawLink(svg, lane, top);
  for (const lane of lanes) drawLane(svg, lane, maxChars, xOf, { top, column, width });
  svg.appendChild(svgEl('line', {
    class: 'timeline-now', x1: xOf(now), x2: xOf(now), y1: top, y2: top + plotHeight,
    stroke: 'var(--text-secondary)', 'stroke-width': 1, 'stroke-dasharray': '4 3',
  }));
  container.replaceChildren(svg);
  return { lanes: lanes.length, live: liveLanes, column: Boolean(column) };
}

export function renderTimeline(live) {
  const panel = document.getElementById('timelinePanel');
  panel.hidden = !live || !live.sessions.some((s) => s.spans.length) || state.currentDays !== 'today';
  if (panel.hidden) {
    timelineSignature = null;
    return;
  }
  const container = document.getElementById('timelineChart');
  const width = chartWidth(container);
  const now = Date.now();
  const signature = timelineKey(live, width, now);
  if (signature === timelineSignature) return;
  timelineSignature = signature;
  hideTooltip();
  const drawn = drawTimeline(container, live.sessions, width, now);
  const totals = rebuildTotals(live.sessions.flatMap((s) => s.rebuilds || []));
  const premium = totals.premium === null ? '' : `, +${formatCost(totals.premium)}`;
  // With the Rebuilds column drawn, the rows carry the rebuilds. Without it (a narrow
  // panel) the note carries the day's total.
  const rebuildNote = totals.count && !drawn.column ? ` · ${plural(totals.count, 'cache rebuild', 'cache rebuilds')}${premium}` : '';
  document.getElementById('timelineNote').textContent =
    `${plural(drawn.lanes, 'session', 'sessions')} today · ${drawn.live} live${rebuildNote}`;
}
