// Each model's share of tokens or of cost as a donut, with its legend.
import { el, svgEl, showTooltip, hideTooltip } from '../dom.mjs';
import { formatCost, formatCostShort, formatTokens, shortModel, escapeHtml } from '../format.mjs';
import { appendPatternDefs, fillFor, modelColor, modelTexture, segmentTexture } from './palette.mjs';

// How each measure reads in the tooltip, the centre of the ring and the aria-label.
const MEASURES = {
  tokens: { value: (n) => `${formatTokens(n)} tokens`, centre: formatTokens, unit: 'tokens' },
  cost: { value: formatCost, centre: formatCostShort, unit: 'cost' },
};

// A donut of each model's share of tokens or of cost across the whole range, with
// the legend beside it. measure is 'tokens' or 'cost'. The Tokens and Cost buttons
// in the panel head pick it (setupModelMixToggle in panels/models.mjs), so one panel
// shows that a model can be 40% of volume and 5% of spend. In the cost view an
// unpriced model has no slice and is listed in the legend as unpriced.
export function drawModelMix(container, models, measure = 'tokens') {
  hideTooltip();
  container.innerHTML = '';

  const { shown, unpriced, total } = mixEntries(models, measure);
  if (!total) {
    const priceGap = measure === 'cost' && models.some((m) => m.tokens > 0);
    const text = priceGap ? 'No priced model usage in this range.' : 'No model usage in this range.';
    container.appendChild(el('div', { class: 'bar-empty', text }));
    return;
  }

  const fmt = MEASURES[measure];
  const pctOf = (m) => (m.value / total) * 100;

  const C = 100;
  const R_OUTER = 96;
  const R_INNER = 62;
  const svg = svgEl('svg', {
    viewBox: '0 0 200 200',
    role: 'img',
    'aria-label': `Share of ${fmt.unit} by model: ${shown.map((m) => `${shortModel(m.model)} ${pctOf(m).toFixed(0)}%`).join(', ')}`,
  });
  appendPatternDefs(svg, 'mix', shown.map((m) => ({ texture: modelTexture(m.family), color: modelColor(m.family) })));

  const slices = donutSlices(shown.map((m) => m.value), C, C, R_OUTER, R_INNER);
  shown.forEach((m, i) => {
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
      showTooltip(evt, `<b>${escapeHtml(shortModel(m.model))}</b><br>${fmt.value(m.value)}<br>${pctOf(m).toFixed(1)}% of ${fmt.unit} in range`)
    );
    path.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(path);
  });

  const centre = svgEl('text', { class: 'donut-total', x: C, y: C, 'text-anchor': 'middle' });
  centre.textContent = fmt.centre(total);
  const unit = svgEl('text', { class: 'donut-unit', x: C, y: C + 16, 'text-anchor': 'middle' });
  unit.textContent = fmt.unit;
  svg.appendChild(centre);
  svg.appendChild(unit);
  container.appendChild(svg);

  // Direct-label each series: identity is never carried by colour alone.
  const legend = el('div', { class: 'legend', id: 'modelLegend' });
  const legendItem = (m, text) =>
    el('span', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: segmentTexture(m.family) }),
      el('span', { text }),
    ]);
  for (const m of shown) legend.appendChild(legendItem(m, `${shortModel(m.model)} ${pctOf(m).toFixed(0)}%`));
  for (const m of unpriced) legend.appendChild(legendItem(m, `${shortModel(m.model)} unpriced`));
  container.appendChild(legend);
}
