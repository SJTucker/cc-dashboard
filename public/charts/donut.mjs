// Each model's share of tokens as a donut, with its legend.
import { el, svgEl, showTooltip, hideTooltip } from '../dom.mjs';
import { formatTokens, shortModel, escapeHtml } from '../format.mjs';
import { appendPatternDefs, fillFor, modelColor, modelTexture, segmentTexture } from './palette.mjs';

// A donut of each model's share of tokens across the whole range, with the legend
// beside it. Sized by tokens, not cost - the Cost by model panel beside it already
// carries dollars, and the contrast between the two is the point (a model can be 40%
// of volume and 5% of spend).
export function drawModelMix(container, models) {
  hideTooltip();
  container.innerHTML = '';

  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  if (!total) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No model usage in this range.' }));
    return;
  }

  const sorted = [...models].sort((a, b) => b.tokens - a.tokens);
  const pctOf = (m) => (m.tokens / total) * 100;

  const C = 100;
  const R_OUTER = 96;
  const R_INNER = 62;
  const svg = svgEl('svg', {
    viewBox: '0 0 200 200',
    role: 'img',
    'aria-label': `Share of tokens by model: ${sorted.map((m) => `${shortModel(m.model)} ${pctOf(m).toFixed(0)}%`).join(', ')}`,
  });
  appendPatternDefs(svg, 'mix', sorted.map((m) => ({ texture: modelTexture(m.family), color: modelColor(m.family) })));

  const slices = donutSlices(sorted.map((m) => m.tokens), C, C, R_OUTER, R_INNER);
  sorted.forEach((m, i) => {
    const slice = slices[i];
    if (!slice.d && !slice.full) return;
    // One model is the whole total: two concentric circles drawn with evenodd make the ring.
    const ring = (r) => `M ${C - r} ${C} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
    const path = svgEl('path', {
      class: 'donut-slice',
      d: slice.full ? `${ring(R_OUTER)} ${ring(R_INNER)}` : slice.d,
      'fill-rule': 'evenodd',
      fill: fillFor('mix', modelTexture(m.family), modelColor(m.family)),
    });
    path.addEventListener('mousemove', (evt) =>
      showTooltip(evt, `<b>${escapeHtml(shortModel(m.model))}</b><br>${formatTokens(m.tokens)} tokens<br>${pctOf(m).toFixed(1)}% of range`)
    );
    path.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(path);
  });

  const centre = svgEl('text', { class: 'donut-total', x: C, y: C, 'text-anchor': 'middle' });
  centre.textContent = formatTokens(total);
  const unit = svgEl('text', { class: 'donut-unit', x: C, y: C + 16, 'text-anchor': 'middle' });
  unit.textContent = 'tokens';
  svg.appendChild(centre);
  svg.appendChild(unit);
  container.appendChild(svg);

  // Direct-label each series: identity is never carried by colour alone.
  const legend = el('div', { class: 'legend', id: 'modelLegend' });
  for (const m of sorted) {
    legend.appendChild(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: segmentTexture(m.family) }),
        el('span', { text: `${shortModel(m.model)} ${pctOf(m).toFixed(0)}%` }),
      ])
    );
  }
  container.appendChild(legend);
}
