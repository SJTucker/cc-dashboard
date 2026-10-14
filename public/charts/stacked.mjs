// Stacked daily bars, one segment per model family.
import { el, svgEl, showTooltip, hideTooltip, chartWidth } from '../dom.mjs';
import { formatCost, formatTokens, shortDate, fullDate, axisCost, axisTokens, familyLabel } from '../format.mjs';
import { CHART_HEIGHT, CHART_PAD_LEFT, CHART_PAD_BOTTOM, drawYAxis } from './axes.mjs';
import { legendRow, swatchIcon } from './legend.mjs';
import { appendPatternDefs, fillFor, modelColor, modelTexture } from './palette.mjs';
import { barSlots, labelStep } from '../chart-geometry.mjs';

// Stacked bars, one segment per model family. Series order is fixed across
// buckets so a model keeps its vertical position and its colour from day to day.
// mode picks whether the segments measure tokens or dollars. The two differ
// sharply because an Opus token costs five Haiku tokens.
export function drawModelDailyChart(container, data, models, mode = 'tokens') {
  const source = mode === 'cost' ? 'costByModel' : 'byModel';
  const axisFmt = mode === 'cost' ? axisCost : axisTokens;
  const tipFmt = mode === 'cost' ? formatCost : (n) => formatTokens(n) + ' tokens';
  const scope = 'model-' + mode;
  hideTooltip();
  container.innerHTML = '';
  // Families, not model names: byModel is family-keyed, and two models of one family
  // share a colour anyway. Deduped so a family with two models yields one segment.
  const order = [...new Set([...models].sort((a, b) => b.tokens - a.tokens).map((m) => m.family))];
  const totals = data.map((d) => order.reduce((s, name) => s + (d[source]?.[name] || 0), 0));

  if (!data.length || totals.every((t) => !t)) {
    container.appendChild(
      el('div', { class: 'bar-empty', text: mode === 'cost' ? 'No priced model usage in this range.' : 'No model usage in this range.' })
    );
    return;
  }

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const rawMax = Math.max(...totals, 1);
  const slots = barSlots(data.length, width - CHART_PAD_LEFT);
  const labelEvery = labelStep(data.length, width - CHART_PAD_LEFT);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  appendPatternDefs(svg, scope, order.map((f) => ({ texture: modelTexture(f), color: modelColor(f) })));
  const max = drawYAxis(svg, rawMax, width, axisFmt);
  svg.appendChild(
    svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 })
  );

  data.forEach((d, i) => {
    const x = CHART_PAD_LEFT + slots.x(i);
    let cursorY = plotHeight;

    for (const name of order) {
      const value = d[source]?.[name] || 0;
      if (!value) continue;
      const segHeight = (value / max) * plotHeight;
      const y = cursorY - segHeight;
      const rect = svgEl('rect', {
        class: 'bar',
        x, y, width: slots.barWidth, height: Math.max(segHeight, 0.5),
        fill: fillFor(scope, modelTexture(name), modelColor(name)),
      });
      rect.addEventListener('mousemove', (evt) =>
        showTooltip(
          evt,
          `<b>${fullDate(d.date)}</b><br>${familyLabel(name)}: ${tipFmt(value)}<br>Bucket total: ${tipFmt(totals[i])}`
        )
      );
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
      cursorY = y;
    }

    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label', x: x + slots.barWidth / 2, y: CHART_HEIGHT - 4, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(d.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
  // One item per family in the chart, in stacking order, so identity never rests
  // on the tooltip.
  const legend = legendRow(order.map((family) => ({
    icon: swatchIcon(modelTexture(family), modelColor(family)),
    label: familyLabel(family),
  })));
  legend.style.marginLeft = `${CHART_PAD_LEFT}px`; // starts at the plot's left edge
  container.appendChild(legend);
}
