// The Session timeline: one lane per session with activity today.
import { svgEl, withTooltip, hideTooltip, chartWidth } from '../dom.mjs';
import { formatCost, escapeHtml } from '../format.mjs';
import { appendPatternDefs, fillFor } from '../charts/palette.mjs';
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
    live.sessions.map((s) => [s.spans, s.live, s.title, s.titleSource, s.project, s.branch, s.costTodayUsd, s.prompts]),
  ]);
}

// A gridline per hour tick, with a label on every step-th one.
function drawHourGrid(svg, ticks, { xOf, width, gutter, plotHeight, height }) {
  const step = labelStep(ticks.length, width - gutter);
  ticks.forEach((t, i) => {
    svg.appendChild(svgEl('line', { x1: xOf(t), x2: xOf(t), y1: 0, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 }));
    if (i % step !== 0) return;
    const label = svgEl('text', { class: 'axis-label', x: xOf(t), y: height - 4, 'text-anchor': 'middle' });
    label.textContent = `${String(new Date(t).getHours()).padStart(2, '0')}:00`;
    svg.appendChild(label);
  });
}

// One session's label in the gutter and its bars.
function drawLane(svg, { session: s, lane, bars }, maxChars) {
  const mid = lane * TIMELINE_LANE_HEIGHT + TIMELINE_LANE_HEIGHT / 2;
  const label = svgEl('text', { class: 'timeline-label', x: 0, y: mid + 4 });
  if (s.titleSource === 'prompt') label.classList.add('prompt-title');
  const fullName = s.title || s.project || '—';
  const glyph = svgEl('tspan', { 'aria-hidden': 'true' });
  glyph.textContent = s.live ? '⬢' : '⬡';
  const name = svgEl('title', {});
  name.textContent = fullName;
  label.append(glyph, ` ${cutLabel(fullName, maxChars)}`, name);
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
}

// Draws the lanes into container. Returns the number of lanes and of live lanes.
function drawTimeline(container, sessions, width, now) {
  const starts = sessions.flatMap((s) => s.spans.map((span) => span[0]));
  const ticks = hourTicks(Math.min(...starts), now);
  const domain = [ticks[0], ticks[ticks.length - 1]];
  const gutter = Math.min(TIMELINE_GUTTER, Math.round(width * 0.4));
  const xOf = (t) => gutter + ((t - domain[0]) / (domain[1] - domain[0])) * (width - gutter - TIMELINE_RIGHT_PAD);
  const lanes = laneLayout(sessions, xOf, now, 3, LIVE_WINDOW_MS);
  const plotHeight = lanes.length * TIMELINE_LANE_HEIGHT;
  const height = plotHeight + TIMELINE_AXIS_HEIGHT;
  const liveLanes = lanes.filter((l) => l.session.live).length;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: 'img',
    'aria-label': `Session timeline: ${plural(lanes.length, 'session', 'sessions')} today, ${liveLanes} live`,
  });
  appendPatternDefs(svg, 'timeline', [{ texture: 'diag', color: TIMELINE_COLOR }]);
  drawHourGrid(svg, ticks, { xOf, width, gutter, plotHeight, height });
  const maxChars = Math.floor((gutter - 8 - 14) / 6.6);
  for (const lane of lanes) drawLane(svg, lane, maxChars);
  svg.appendChild(svgEl('line', {
    class: 'timeline-now', x1: xOf(now), x2: xOf(now), y1: 0, y2: plotHeight,
    stroke: 'var(--text-secondary)', 'stroke-width': 1, 'stroke-dasharray': '4 3',
  }));
  container.replaceChildren(svg);
  return { lanes: lanes.length, live: liveLanes };
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
  document.getElementById('timelineNote').textContent =
    `${plural(drawn.lanes, 'session', 'sessions')} today · ${drawn.live} live`;
}
