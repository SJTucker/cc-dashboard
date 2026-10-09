// The summary cards. The Record day card and the 7d total lines are in records.mjs.
import { formatCost, formatTokens, formatPercent, costPerDay } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { renderWeekTotals, renderRecord } from './records.mjs';

// The compact header card on Today has room for a short note only, so there the
// full sentence moves to the note's tooltip.
function renderCostCard(s) {
  document.getElementById('cardCost').textContent = formatCost(s.totalCost);
  const unpricedNote = s.unpricedTokens
    ? `${formatTokens(s.unpricedTokens)} tokens from unrecognized models not priced`
    : '';
  const costNote = document.getElementById('cardCostNote');
  const compact = state.currentDays === 'today';
  costNote.textContent = compact && s.unpricedTokens
    ? `${formatTokens(s.unpricedTokens)} unpriced`
    : unpricedNote;
  costNote.title = compact ? unpricedNote : '';
}

// Claude Code's own per-session counters, shown as a separate card rather than
// folded into Total cost. Only present on the all-time range, and only for the
// sessions that wrote a cost-state line, so it is a floor on what the
// per-request scan misses, not a replacement total.
function renderReportedCard(s) {
  document.getElementById('reportedCard').hidden = s.reportedCost == null;
  if (s.reportedCost == null || !shown('card-reported')) return;
  document.getElementById('cardReported').textContent = formatCost(s.reportedCost);
  document.getElementById('cardReportedNote').textContent =
    `${s.reportedSessions} of ${s.reportedSessionsOf} sessions`;
}

// Burn rate and the 30-day projection. Today has hourly buckets, where a daily
// rate has no meaning, so both cards hide there.
function renderRateCards(daily) {
  const perDay = state.currentDays === 'today' ? null : costPerDay(daily);
  document.getElementById('burnCard').hidden = perDay == null;
  document.getElementById('projectionCard').hidden = perDay == null;
  if (perDay == null) return;
  if (shown('card-burn')) document.getElementById('cardBurn').textContent = formatCost(perDay);
  if (shown('card-projection')) document.getElementById('cardProjection').textContent = formatCost(perDay * 30);
}

export function renderCards(data) {
  const s = data.summary;
  if (shown('card-cost')) renderCostCard(s);
  if (shown('card-tokens')) document.getElementById('cardTokens').textContent = formatTokens(s.totalTokens);
  renderWeekTotals(s);
  if (shown('card-cache')) document.getElementById('cardCache').textContent = formatPercent(s.cacheEfficiency);
  renderReportedCard(s);
  if (shown('card-files')) document.getElementById('cardFiles').textContent = data.meta.scannedFiles;
  if (shown('card-tools')) document.getElementById('cardTools').textContent = s.toolCalls.toLocaleString('en-US');
  if (shown('card-record')) renderRecord(data.daily);
  renderRateCards(data.daily);
}
