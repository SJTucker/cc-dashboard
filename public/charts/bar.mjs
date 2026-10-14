// Single-series bars and the cumulative cost line, against a time axis of buckets.
import { el, svgEl, showTooltip, hideTooltip, chartWidth } from '../dom.mjs';
import { formatCost, shortDate, fullDate, axisCost, axisTokens } from '../format.mjs';
import { CHART_HEIGHT, CHART_PAD_LEFT, CHART_PAD_BOTTOM, drawYAxis, drawSignedYAxis } from './axes.mjs';
import { barSlots, labelStep } from '../chart-geometry.mjs';

export function drawBarChart(container, data, { color, valueKey, tooltipFn }) {
  hideTooltip();
  container.innerHTML = '';
  const allZero = data.every((d) => !d[valueKey]);
  if (!data.length || allZero) {
    const text = data.length && valueKey === 'cost'
      ? 'No priced usage in this range.'
      : 'No usage in this range.';
    container.appendChild(el('div', { class: 'bar-empty', text }));
    return;
  }

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const values = data.map((d) => d[valueKey]);
  const rawMin = Math.min(...values, 0);
  const slots = barSlots(data.length, width - CHART_PAD_LEFT);
  const labelEvery = labelStep(data.length, width - CHART_PAD_LEFT);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  const format = valueKey === 'cost' ? axisCost : axisTokens;
  // Only a chart with a value below zero gets the signed axis, so every
  // all-positive chart draws exactly as before.
  const { zeroY, yOf } = rawMin < 0
    ? drawSignedYAxis(svg, rawMin, Math.max(...values, 0), width, format)
    : positiveScale(drawYAxis(svg, Math.max(...values, 0.0001), width, format), plotHeight);

  // Zero line
  svg.appendChild(
    svgEl('line', {
      x1: CHART_PAD_LEFT, x2: width, y1: zeroY, y2: zeroY,
      stroke: 'var(--border)', 'stroke-width': 1,
    })
  );

  data.forEach((d, i) => {
    const value = d[valueKey];
    const x = CHART_PAD_LEFT + slots.x(i);

    // A negative bar hangs below the zero line in the same colour.
    const rect = svgEl('rect', {
      class: 'bar',
      x, ...barRect(value, { yOf, zeroY }), width: slots.barWidth,
      rx: 2,
      fill: color,
    });
    rect.addEventListener('mousemove', (evt) => showTooltip(evt, tooltipFn(d)));
    rect.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(rect);

    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label',
        x: x + slots.barWidth / 2, y: CHART_HEIGHT - 4,
        'text-anchor': 'middle',
      });
      label.textContent = shortDate(d.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

// The top edge and height of one bar. It spans zeroY to the value's y on either side
// of zero, and a non-zero value is at least 1px tall so it stays visible.
export function barRect(value, { yOf, zeroY }) {
  const y = yOf(value);
  return { y: Math.min(y, zeroY), height: Math.max(Math.abs(zeroY - y), value !== 0 ? 1 : 0) };
}

// The scale of an all-positive chart: zero at the bottom of the plot. max comes
// from drawYAxis and is never 0.
function positiveScale(max, plotHeight) {
  return { zeroY: plotHeight, yOf: (value) => plotHeight - (value / max) * plotHeight };
}

// A running total across the range's buckets. One path, plus a transparent
// hover target per bucket so the tooltip works anywhere in a column rather than
// only within a few pixels of the line.
export function drawCumulativeChart(container, data) {
  hideTooltip();
  container.innerHTML = '';
  if (!data.length || data.every((d) => !d.cost)) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No priced usage in this range.' }));
    return;
  }

  let running = 0;
  const points = data.map((d) => ({ date: d.date, total: (running += d.cost) }));

  // Buckets outside the spending are zero-filled - the Today range always carries
  // a full 24-hour axis - and a flat line across them reads as usage continuing at
  // that level rather than as nothing happening. The line is drawn only over the
  // buckets that spent, starting one earlier so it still rises from zero. A flat
  // stretch BETWEEN two spends stays, because that is what a cumulative total
  // genuinely does there. The axis keeps its full width either way, so the labels
  // do not move.
  const drawTo = data.map((d) => d.cost > 0).lastIndexOf(true);
  const drawFrom = Math.max(data.findIndex((d) => d.cost > 0) - 1, 0);
  const drawn = points.slice(drawFrom, drawTo + 1);

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const step = (width - CHART_PAD_LEFT) / Math.max(points.length - 1, 1);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  const max = drawYAxis(svg, points[points.length - 1].total, width, axisCost);
  svg.appendChild(
    svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 })
  );

  const xAt = (i) => CHART_PAD_LEFT + i * step;
  const yAt = (total) => plotHeight - (total / max) * plotHeight;

  // A one-bucket range yields a moveto with no lineto, which draws nothing at
  // all. Give it a short horizontal segment so a single day still shows its
  // running total instead of an apparently empty panel.
  const d =
    drawn.length === 1
      ? `M${xAt(drawFrom)},${yAt(drawn[0].total)} L${xAt(drawFrom) + Math.max(step, 2)},${yAt(drawn[0].total)}`
      : drawn.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(drawFrom + i)},${yAt(p.total)}`).join(' ');
  svg.appendChild(svgEl('path', { class: 'cumulative-line', d, fill: 'none' }));

  points.forEach((p, i) => {
    if (i >= drawFrom && i <= drawTo) {
      const hit = svgEl('rect', {
        x: xAt(i) - step / 2, y: 0, width: Math.max(step, 1), height: plotHeight, fill: 'transparent',
      });
      hit.addEventListener('mousemove', (evt) =>
        showTooltip(evt, `<b>${fullDate(p.date)}</b><br>Running total: ${formatCost(p.total)}`)
      );
      hit.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(hit);
    }

    const labelEvery = labelStep(points.length, width - CHART_PAD_LEFT);
    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label', x: xAt(i), y: CHART_HEIGHT - 4, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(p.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}
