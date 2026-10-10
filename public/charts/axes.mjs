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

// The y axis for a bar chart with values below zero (the rtk chart, when rtk's
// output put more into context than it kept out). One tick step serves both
// sides, so gridlines below zero are spaced like those above. zeroY is the y of the
// zero line, and yOf maps a value to its y in the plot. Zero has no tick: the
// chart draws its own zero line.
export function signedTicks(rawMin, rawMax, ticks = 4) {
  const { step } = axisScale(rawMax - rawMin, ticks);
  const up = Math.max(Math.ceil(rawMax / step), 0);
  const down = Math.ceil(-rawMin / step);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const yOf = (value) => ((up * step - value) / ((up + down) * step)) * plotHeight;
  const out = [];
  for (let i = -down; i <= up; i++) {
    if (i !== 0) out.push({ value: i * step, y: yOf(i * step) });
  }
  return { zeroY: yOf(0), yOf, ticks: out };
}

// Draws the gridlines and labels from signedTicks and returns its result.
export function drawSignedYAxis(svg, rawMin, rawMax, width, format, ticks = 4) {
  const scale = signedTicks(rawMin, rawMax, ticks);
  for (const { value, y } of scale.ticks) {
    svg.appendChild(svgEl('line', { class: 'gridline', x1: CHART_PAD_LEFT, x2: width, y1: y, y2: y }));
    const label = svgEl('text', {
      class: 'axis-label', x: CHART_PAD_LEFT - 6, y: y + 3, 'text-anchor': 'end',
    });
    label.textContent = format(value);
    svg.appendChild(label);
  }
  return scale;
}

// The y axis of the Setup changes chart. Two differences from yTicks: it has a
// tick for 0 at the baseline, and its top is above the data, because the median
// labels sit above their lines and a bar as tall as the data max would touch the
// top gridline. top is the y of the plot's top edge in the SVG.
export const PLOT_HEADROOM = 1.12;

export function plotTicks(rawMax, { top, plotHeight, ticks = 4 }) {
  const { step, max } = axisScale(rawMax * PLOT_HEADROOM, ticks);
  const yOf = (value) => top + plotHeight - (value / max) * plotHeight;
  const out = [{ value: 0, y: yOf(0) }];
  for (let i = 1; i * step <= max * 1.0001; i++) out.push({ value: i * step, y: yOf(i * step) });
  return { max, ticks: out };
}

// Draws the gridlines and labels from plotTicks and returns the rounded max.
export function drawPlotAxis(svg, rawMax, { left, right, top, plotHeight, format }) {
  const { max, ticks } = plotTicks(rawMax, { top, plotHeight });
  for (const { value, y } of ticks) {
    if (value) svg.appendChild(svgEl('line', { class: 'gridline', x1: left, x2: right, y1: y, y2: y }));
    const label = svgEl('text', { class: 'axis-label', x: left - 6, y: y + 3, 'text-anchor': 'end' });
    label.textContent = value ? format(value) : '0';
    svg.appendChild(label);
  }
  return max;
}
