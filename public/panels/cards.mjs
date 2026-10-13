// The summary cards on the Analysis tab, for the range picked there. The sticky
// bar's stats are in sticky.mjs.
import { formatCost, formatTokens, formatPercent, costPerDay, thinkingShare, thinkingNote, unpricedNote } from '../format.mjs';
import { state, shown } from '../state.mjs';

function renderCostCard(s) {
  document.getElementById('cardCost').textContent = formatCost(s.totalCost);
  document.getElementById('cardCostNote').textContent = unpricedNote(s);
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

// Burn rate and the 30-day projection, from complete days only.
function renderRateCards(daily) {
  const perDay = state.currentDays === 'today' ? null : costPerDay(daily);
  document.getElementById('burnCard').hidden = perDay == null;
  document.getElementById('projectionCard').hidden = perDay == null;
  if (perDay == null) return;
  if (shown('card-burn')) document.getElementById('cardBurn').textContent = formatCost(perDay);
  if (shown('card-projection')) document.getElementById('cardProjection').textContent = formatCost(perDay * 30);
}

// The share is of the calls that report thinking, so the note says how many do.
function renderThinkingCard(s) {
  const note = thinkingNote(s);
  document.getElementById('cardThinking').textContent = formatPercent(thinkingShare(s));
  document.getElementById('cardThinkingNote').textContent = note;
  document.getElementById('thinkingCard').title = note;
}

export function renderCards(data) {
  const s = data.summary;
  if (shown('card-cost')) renderCostCard(s);
  if (shown('card-tokens')) document.getElementById('cardTokens').textContent = formatTokens(s.totalTokens);
  if (shown('card-cache')) document.getElementById('cardCache').textContent = formatPercent(s.cacheEfficiency);
  if (shown('card-thinking')) renderThinkingCard(s);
  renderReportedCard(s);
  if (shown('card-tools')) document.getElementById('cardTools').textContent = s.toolCalls.toLocaleString('en-US');
  renderRateCards(data.daily);
}
