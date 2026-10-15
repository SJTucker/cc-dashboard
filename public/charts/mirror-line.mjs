// Lines added above a zero line and lines deleted below it, one line pair per series,
// on a linear axis. The Lines of code panel draws one series per repo. A series'
// two lines share its colour and dash, and the series is named once, at the right
// end of its added line.
import { el, svgEl, showTooltip, hideTooltip, chartWidth } from '../dom.mjs';
import { shortDate, fullDate, axisTokens, escapeHtml } from '../format.mjs';
import { CHART_HEIGHT, CHART_PAD_LEFT, CHART_PAD_BOTTOM, drawSignedYAxis } from './axes.mjs';
import { legendRow, lineIcon } from './legend.mjs';
import { labelStep } from '../chart-geometry.mjs';

// Room right of the plot for the end labels, which are cut to LABEL_CHARS.
const LABEL_GUTTER = 84;
const LABEL_CHARS = 12;

const count = (n) => n.toLocaleString('en-US');
const shortLabel = (label) => (label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label);

// The y of each end label, given the y of its line's last point. Labels are placed
// top to bottom, each at least `gap` below the one above and none above `top`, so
// two lines ending close together keep readable names. When the last label would
// be below `bottom`, the whole stack moves up by the overflow, but not above `top`.
// The result keeps the input order.
export function spreadLabels(ys, gap = 11, top = 8, bottom = Infinity) {
  const out = new Array(ys.length);
  let previous = -Infinity;
  for (const [y, i] of ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0])) {
    out[i] = Math.max(y, previous + gap, top);
    previous = out[i];
  }
  const overflow = Math.max(0, previous - bottom);
  if (overflow) {
    const shift = Math.min(overflow, Math.min(...out) - top);
    for (let i = 0; i < out.length; i++) out[i] -= shift;
  }
  return out;
}

function strokeOf(s) {
  return { fill: 'none', stroke: s.color, ...(s.dash ? { 'stroke-dasharray': s.dash } : {}) };
}

export function drawMirroredLineChart(container, dates, series) {
  hideTooltip();
  container.innerHTML = '';
  if (!dates.length || !series.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No edits in this range.' }));
    return;
  }

  const width = chartWidth(container);
  const plotRight = width - LABEL_GUTTER;
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });

  // Deleted lines are drawn as negative values, and the axis labels both halves
  // with the absolute count.
  const rawMax = Math.max(1, ...series.flatMap((s) => s.added));
  const rawMin = -Math.max(1, ...series.flatMap((s) => s.removed));
  const { zeroY, yOf } = drawSignedYAxis(svg, rawMin, rawMax, plotRight, (v) => axisTokens(Math.abs(v)));
  svg.appendChild(svgEl('line', { x1: CHART_PAD_LEFT, x2: plotRight, y1: zeroY, y2: zeroY, stroke: 'var(--border)', 'stroke-width': 1 }));
  // drawSignedYAxis labels no tick at zero, so the 0 and the two half names are added here.
  const zeroLabel = svgEl('text', { class: 'axis-label', x: CHART_PAD_LEFT - 6, y: zeroY + 3, 'text-anchor': 'end' });
  zeroLabel.textContent = '0';
  svg.appendChild(zeroLabel);
  for (const [name, y] of [['added', zeroY - 4], ['deleted', zeroY + 11]]) {
    const half = svgEl('text', { class: 'axis-label', x: CHART_PAD_LEFT + 4, y, 'text-anchor': 'start' });
    half.textContent = name;
    svg.appendChild(half);
  }

  const step = (plotRight - CHART_PAD_LEFT) / Math.max(dates.length - 1, 1);
  const xAt = (i) => CHART_PAD_LEFT + i * step;

  for (const s of series) {
    for (const [values, sign] of [[s.added, 1], [s.removed, -1]]) {
      // A path with one point draws nothing, so a one-day range gets dots.
      if (dates.length === 1) {
        svg.appendChild(svgEl('circle', { cx: xAt(0), cy: yOf(sign * values[0]), r: 2.5, fill: s.color }));
        continue;
      }
      const d = values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i)},${yOf(sign * v)}`).join(' ');
      svg.appendChild(svgEl('path', { class: 'log-line', d, ...strokeOf(s) }));
    }
  }

  const last = dates.length - 1;
  const ys = spreadLabels(series.map((s) => yOf(s.added[last]) + 3), 11, 8, plotHeight);
  series.forEach((s, i) => {
    const label = svgEl('text', { class: 'axis-label line-end-label', x: xAt(last) + 6, y: ys[i], style: `fill:${s.color}` });
    label.textContent = shortLabel(s.label);
    svg.appendChild(label);
  });

  const crosshair = svgEl('line', { class: 'crosshair', y1: 0, y2: plotHeight, visibility: 'hidden' });
  svg.appendChild(crosshair);

  // One full-height hit target per day, as on the token chart: the question is what
  // every repo did that day, and a 2px stroke is too small to aim at.
  const labelEvery = labelStep(dates.length, plotRight - CHART_PAD_LEFT);
  dates.forEach((date, i) => {
    const hit = svgEl('rect', { x: xAt(i) - step / 2, y: 0, width: Math.max(step, 1), height: plotHeight, fill: 'transparent' });
    hit.addEventListener('mousemove', (evt) => {
      crosshair.setAttribute('x1', xAt(i));
      crosshair.setAttribute('x2', xAt(i));
      crosshair.setAttribute('visibility', 'visible');
      const rows = series.map((s) => `${escapeHtml(s.label)}: +${count(s.added[i])} / −${count(s.removed[i])}`).join('<br>');
      showTooltip(evt, `<b>${fullDate(date)}</b><br>${rows}`);
    });
    hit.addEventListener('mouseleave', () => {
      crosshair.setAttribute('visibility', 'hidden');
      hideTooltip();
    });
    svg.appendChild(hit);
    if (i % labelEvery === 0) {
      const label = svgEl('text', { class: 'axis-label', x: xAt(i), y: CHART_HEIGHT - 4, 'text-anchor': 'middle' });
      label.textContent = shortDate(date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

// The side legend: a dash sample, the full label and the range totals per series.
// Hovering Other lists the repos summed into it.
export function drawLinesLegend(container, series) {
  const items = series.map((s) => ({
    icon: lineIcon(s.color, s.dash),
    label: s.label,
    value: `+${count(s.totalAdded)} / −${count(s.totalRemoved)}`,
    ...(s.members.length ? { title: s.members.join(', ') } : {}),
  }));
  container.replaceChildren(legendRow(items, 'side-legend'));
}
