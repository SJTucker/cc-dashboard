// Cost by model, the model mix donut, and the model daily charts.
import { el } from '../dom.mjs';
import { formatCost, formatTokens, escapeHtml } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { segmentTexture } from '../charts/palette.mjs';
import { drawModelMix } from '../charts/donut.mjs';
import { drawModelDailyChart } from '../charts/stacked.mjs';

// A table rather than a list, because $/MTok is the number that explains why a
// model's token share and its cost share are different. escapeHtml is used on
// the model name: it comes from a log file, not from this codebase.
function drawModelList(container, models) {
  container.innerHTML = '';
  if (!models.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No model usage in this range.' }));
    return;
  }

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  const rows = models
    .map((m) => {
      // An unpriced model's cost is 0 because no rate is known. Showing $0.00,
      // 0.0% or $0.00/MTok would read as a measured value.
      const unpriced = !m.priced;
      const perMillion = m.tokens > 0 ? m.cost / (m.tokens / 1e6) : 0;
      const share = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
      return `<tr>
        <td class="model-name"><span class="swatch" style="${segmentTexture(m.family)}"></span>${escapeHtml(m.model)}</td>
        <td class="num">${formatTokens(m.tokens)}</td>
        <td class="num cost-cell">${unpriced ? 'unpriced' : formatCost(m.cost)}</td>
        <td class="num">${unpriced ? '&mdash;' : share.toFixed(1) + '%'}</td>
        <td class="num">${unpriced ? '&mdash;' : formatCost(perMillion)}</td>
      </tr>`;
    })
    .join('');

  container.innerHTML = `<table class="model-table">
    <thead><tr>
      <th>Model</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Share</th><th class="num">$/MTok</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function renderModels(data) {
  if (shown('costByModel')) drawModelList(document.getElementById('modelList'), data.models);
  if (shown('modelMix')) drawModelMix(document.getElementById('modelMixChart'), data.models);
  // An hourly model split is noise, so the over-time view is multi-day only. The mix
  // donut and the Cost by model panel stay on every range, Today included.
  const multiDay = state.currentDays !== 'today';
  document.getElementById('modelDailyPanel').hidden = !multiDay;
  document.getElementById('modelCostDailyPanel').hidden = !multiDay;
  if (!multiDay) return;
  if (shown('modelDaily')) drawModelDailyChart(document.getElementById('modelDailyChart'), data.daily, data.models);
  if (shown('modelCostDaily')) drawModelDailyChart(document.getElementById('modelCostDailyChart'), data.daily, data.models, 'cost');
}
