// Cost by model, the model mix donut, and the model daily charts.
import { el } from '../dom.mjs';
import { formatCost, formatTokens, formatPercent, thinkingShare, escapeHtml } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { segmentTexture } from '../charts/palette.mjs';
import { drawModelMix, flipDonut } from '../charts/donut.mjs';
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

// The Model mix measure is kept in localStorage, so the page reopens on the view
// last picked. Storage can throw (a private window, blocked site data); then the
// page starts on tokens and a switch holds for this page view.
const MIX_MEASURE_KEY = 'cc-dashboard:model-mix-measure';

// The models renderModels last received, so a switch redraws with no request.
let lastModels = null;
// What the donut shows now. flipMix compares them with state.mixMeasure and
// lastModels after a flip, to catch a click or a poll that landed during it.
let drawnMeasure = null;
let drawnModels = null;
let flipping = false;

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

function drawMix() {
  drawnMeasure = state.mixMeasure;
  drawnModels = lastModels;
  drawModelMix(document.getElementById('modelMixChart'), lastModels, drawnMeasure);
}

function syncMixButtons() {
  for (const btn of document.querySelectorAll('#mixMeasure button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.measure === state.mixMeasure));
  }
}

// Flips the donut to state.mixMeasure. A click after the edge-on redraw changes
// state.mixMeasure without starting a flip, so the donut flips again when this one
// ends. renderModels does not draw during a flip, so a poll that arrived after the
// redraw is drawn here, with no animation.
async function flipMix() {
  flipping = true;
  try {
    await flipDonut(document.getElementById('modelMixChart'), drawMix);
  } finally {
    flipping = false;
  }
  if (drawnMeasure !== state.mixMeasure) flipMix();
  else if (shown('modelMix') && drawnModels !== lastModels) drawMix();
}

function switchMix(measure) {
  if (measure === state.mixMeasure) return;
  state.mixMeasure = measure;
  saveMixMeasure();
  syncMixButtons();
  if (lastModels && !flipping) flipMix();
}

// Wires the Tokens and Cost buttons in the Model mix head, and a click on the
// donut, which switches to the other measure. Runs once at startup, before the
// first render, so the first draw already uses the saved measure.
export function setupModelMixToggle() {
  state.mixMeasure = loadMixMeasure();
  syncMixButtons();
  for (const btn of document.querySelectorAll('#mixMeasure button')) {
    btn.addEventListener('click', () => switchMix(btn.dataset.measure));
  }
  document.getElementById('modelMixChart').addEventListener('click', (evt) => {
    if (evt.target.closest('svg')) switchMix(state.mixMeasure === 'cost' ? 'tokens' : 'cost');
  });
}

export function renderModels(data) {
  if (shown('costByModel')) drawModelList(document.getElementById('modelList'), data.models);
  lastModels = data.models;
  // During a flip, flipMix draws the newest models itself.
  if (shown('modelMix') && !flipping) drawMix();
  // An hourly model split is noise, so the over-time view is multi-day only. The mix
  // donut and the Cost by model panel stay on every range, Today included.
  const multiDay = state.currentDays !== 'today';
  document.getElementById('modelDailyPanel').hidden = !multiDay;
  document.getElementById('modelCostDailyPanel').hidden = !multiDay;
  if (!multiDay) return;
  if (shown('modelDaily')) drawModelDailyChart(document.getElementById('modelDailyChart'), data.daily, data.models);
  if (shown('modelCostDaily')) drawModelDailyChart(document.getElementById('modelCostDailyChart'), data.daily, data.models, 'cost');
}
