// The chart size and the y axis every bar and line chart shares.
import { svgEl } from '../dom.mjs';

export const CHART_HEIGHT = 180;
export const CHART_PAD_LEFT = 46;
export const CHART_PAD_BOTTOM = 20;

// Rounds the top of the scale up to the next 1/2/5 x 10^n tick (axisScale in
// public/chart-geometry.js) and lists the gridlines from the first step up to
// that top, each with its y in the plot. The point is reading a value off the
// chart without hovering, so the ticks have to be round numbers, which means the
// scale top follows from the tick step rather than from the data max. The max is
// never 0, so a caller can divide by it.
export function yTicks(rawMax, ticks = 4) {
  const { step, max } = axisScale(rawMax, ticks);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const out = [];
  for (let i = 1; i * step <= max * 1.0001; i++) {
    const value = i * step;
    out.push({ value, y: plotHeight - (value / max) * plotHeight });
  }
  return { max, ticks: out };
}

// Draws the gridlines and their labels from yTicks and returns the rounded max
// for the bars to scale against.
export function drawYAxis(svg, rawMax, width, format, ticks = 4) {
  const { max, ticks: lines } = yTicks(rawMax, ticks);
  for (const { value, y } of lines) {
    svg.appendChild(svgEl('line', { class: 'gridline', x1: CHART_PAD_LEFT, x2: width, y1: y, y2: y }));
    const label = svgEl('text', {
      class: 'axis-label', x: CHART_PAD_LEFT - 6, y: y + 3, 'text-anchor': 'end',
    });
    label.textContent = format(value);
    svg.appendChild(label);
  }
  return max;
}
