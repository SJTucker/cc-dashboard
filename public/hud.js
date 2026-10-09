'use strict';

// Loaded two ways: index.html loads it as a script before main.mjs, which makes these
// functions globals, and the tests load it with require().

// The status strip's display strings. loadedAt is the time of the last successful
// summary load, shown as 24-hour local time. range is the active range button's
// label. A value not known yet shows as a dash.
function formatStatus({ loadedAt, range, sessions, apiCalls }) {
  const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  return {
    sync: typeof loadedAt === 'number' ? new Date(loadedAt).toLocaleTimeString('en-GB', { hour12: false }) : '—',
    range: range || '—',
    sessions: count(sessions),
    apiCalls: count(apiCalls),
  };
}

// The Today row of Plan usage fills against 100% of the week, like the weekly rows.
// tick is the day's budget as a percent of the week, or null at the weekend, which
// has no budget.
function shareMeter(today) {
  return {
    fill: Math.min(100, Math.max(0, today.share)),
    tick: typeof today.budget === 'number' ? today.budget : null,
  };
}

// The daily warning fires one point short of the day's budget, so there is room to
// stop before it.
const DAILY_WARN_MARGIN = 1;

// Whether the Plan usage banner warns about today's share of the week. It compares
// against the rolling budget: the weekly percent left at the start of today, spread
// over the workdays left before the reset. When the reset time is unknown there is no
// rolling budget, so it falls back to the fixed budget. A weekend has neither, so it
// never warns. Both values are rounded, as the panel shows them. Returns
// { share, budget, rolling } or null.
function dailyWarning(today) {
  if (!today) return null;
  const rolling = typeof today.rollingBudget === 'number';
  const raw = rolling ? today.rollingBudget : today.budget;
  if (typeof raw !== 'number') return null;
  const share = Math.round(today.share);
  const budget = Math.round(raw);
  return share >= budget - DAILY_WARN_MARGIN ? { share, budget, rolling } : null;
}

if (typeof module === 'object') module.exports = { formatStatus, shareMeter, dailyWarning };
