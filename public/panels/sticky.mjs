// The three stats in the sticky bar: today's cost and tokens, each with its rolling
// 7 days, and the record day. They show today on both tabs and every range.
import { formatCost, formatTokens, unpricedNote } from '../format.mjs';
import { renderWeekTotals, renderRecord } from './records.mjs';

// data is an /api/summary?days=today payload.
export function renderSticky(data) {
  const s = data.summary;
  const cost = document.getElementById('stickyCost');
  cost.textContent = formatCost(s.totalCost);
  cost.title = unpricedNote(s);
  document.getElementById('stickyTokens').textContent = formatTokens(s.totalTokens);
  renderWeekTotals(s);
  renderRecord(data.daily);
}
