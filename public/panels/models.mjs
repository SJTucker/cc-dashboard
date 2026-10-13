// The Models panel (each model's share as a bar, then a table of tokens, cost,
// share, $/MTok and thinking) and the model daily charts.
import { formatCost, formatTokens, formatPercent, thinkingShare, modelLabel, escapeHtml } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { segmentTexture, modelColor, modelTexture } from '../charts/palette.mjs';
import { drawShareBar } from '../charts/split.mjs';
import { swatchIcon } from '../charts/legend.mjs';
import { drawModelDailyChart } from '../charts/stacked.mjs';

// A table rather than a list, because $/MTok is the number that explains why a
// model's token share and its cost share are different. The name shows as
// modelLabel ("Opus 5.5") with the full id in its title. Both are escaped: they come
// from a log file, not from this codebase.
function drawModelList(container, models) {
  container.innerHTML = '';
  // The share bar above shows the empty message, so the table shows nothing.
  if (!models.length) return;

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  const rows = models
    .map((m) => {
      // An unpriced model's cost is 0 because no rate is known. Showing $0.00,
      // 0.0% or $0.00/MTok would read as a measured value.
      const unpriced = !m.priced;
      const perMillion = m.tokens > 0 ? m.cost / (m.tokens / 1e6) : 0;
      const share = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
      return `<tr>
        <td class="model-name" title="${escapeHtml(m.model)}"><span class="swatch" style="${segmentTexture(m.family)}"></span>${escapeHtml(modelLabel(m.model))}</td>
        <td class="num">${formatTokens(m.tokens)}</td>
        <td class="num cost-cell">${unpriced ? 'unpriced' : formatCost(m.cost)}</td>
        <td class="num">${unpriced ? '&mdash;' : share.toFixed(1) + '%'}</td>
        <td class="num">${unpriced ? '&mdash;' : formatCost(perMillion)}</td>
        <td class="num">${formatPercent(thinkingShare(m))}</td>
      </tr>`;
    })
    .join('');

  container.innerHTML = `<table class="model-table">
    <thead><tr>
      <th>Model</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Share</th><th class="num">$/MTok</th><th class="num">Thinking</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// The share bar's measure is kept in localStorage, so the page reopens on the view
// last picked. Storage can throw (a private window, blocked site data); then the
// page starts on tokens and a switch holds for this page view.
const MIX_MEASURE_KEY = 'cc-dashboard:model-mix-measure';

// The models renderModels last received, so a switch redraws with no request.
let lastModels = null;

function loadMixMeasure() {
  try {
    return localStorage.getItem(MIX_MEASURE_KEY) === 'cost' ? 'cost' : 'tokens';
  } catch {
    return 'tokens';
  }
}

function saveMixMeasure() {
  try {
    localStorage.setItem(MIX_MEASURE_KEY, state.mixMeasure);
  } catch {
    // Not saved. The choice holds for this page view.
  }
}

// How each measure reads in a segment's tooltip.
const MEASURE_TEXT = { tokens: (n) => `${formatTokens(n)} tokens`, cost: formatCost };

// Each model's share of tokens or of cost. In the cost view an unpriced model has no
// segment and is listed after the shares as unpriced.
function drawShare() {
  const { shown: entries, unpriced, total } = mixEntries(lastModels, state.mixMeasure);
  const text = MEASURE_TEXT[state.mixMeasure];
  const priceGap = state.mixMeasure === 'cost' && lastModels.some((m) => m.tokens > 0);
  drawShareBar(document.getElementById('modelShare'), entries.map((m) => ({
    name: modelLabel(m.model),
    value: m.value,
    texture: modelTexture(m.family),
    color: modelColor(m.family),
    tooltip: `<b>${escapeHtml(modelLabel(m.model))}</b><br>${text(m.value)} &middot; ${total ? ((m.value / total) * 100).toFixed(1) : '0.0'}%`,
  })), {
    empty: priceGap ? 'No priced model usage in this range.' : 'No model usage in this range.',
    extra: unpriced.map((m) => ({ icon: swatchIcon(modelTexture(m.family), modelColor(m.family)), label: modelLabel(m.model), value: 'unpriced' })),
  });
}

function syncMixButtons() {
  for (const btn of document.querySelectorAll('#mixMeasure button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.measure === state.mixMeasure));
  }
}

function switchMix(measure) {
  if (measure === state.mixMeasure) return;
  state.mixMeasure = measure;
  saveMixMeasure();
  syncMixButtons();
  if (lastModels && shown('costByModel')) drawShare();
}

// Wires the Tokens and Cost buttons in the Models head. Runs once at startup, before
// the first render, so the first draw already uses the saved measure.
export function setupModelMixToggle() {
  state.mixMeasure = loadMixMeasure();
  syncMixButtons();
  for (const btn of document.querySelectorAll('#mixMeasure button')) {
    btn.addEventListener('click', () => switchMix(btn.dataset.measure));
  }
}

export function renderModels(data) {
  lastModels = data.models;
  if (shown('costByModel')) {
    drawShare();
    drawModelList(document.getElementById('modelList'), data.models);
  }
  // An hourly model split is noise, so the over-time view is multi-day only.
  const multiDay = state.currentDays !== 'today';
  document.getElementById('modelDailyPanel').hidden = !multiDay;
  document.getElementById('modelCostDailyPanel').hidden = !multiDay;
  if (!multiDay) return;
  if (shown('modelDaily')) drawModelDailyChart(document.getElementById('modelDailyChart'), data.daily, data.models);
  if (shown('modelCostDaily')) drawModelDailyChart(document.getElementById('modelCostDailyChart'), data.daily, data.models, 'cost');
}
