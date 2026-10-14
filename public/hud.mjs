// The status strip's display strings. loadedAt is the time of the last successful
// summary load, shown as 24-hour local time. A value not known yet shows as a dash.
function formatStatus({ loadedAt, sessions, apiCalls }) {
  const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  return {
    sync: typeof loadedAt === 'number' ? new Date(loadedAt).toLocaleTimeString('en-GB', { hour12: false }) : '—',
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

// Short names for the plan windows in the status strip, by the window keys in
// WINDOWS (lib/limits.js). An unknown key shows the window's own label.
const LIMIT_SHORT_NAMES = { five_hour: 'Session', seven_day: 'Week' };

// The one-line form of #limitsBanner for the sticky status strip. `high` is
// the windows at or past the warn percent and `dayHigh` is dailyWarning's result.
// The label is Limit when a window is high and Budget when only today's budget is.
// Returns { label, value } or null when the banner is hidden.
function limitStripText(high, dayHigh) {
  if (!high.length && !dayHigh) return null;
  const parts = high.map((l) => `${LIMIT_SHORT_NAMES[l.key] || l.label} ${Math.round(l.percent)}%`);
  if (dayHigh) parts.push(`Today ${dayHigh.share}%`);
  return { label: high.length ? 'Limit' : 'Budget', value: parts.join(' · ') };
}

export { formatStatus, shareMeter, dailyWarning, limitStripText };
