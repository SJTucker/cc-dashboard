'use strict';

// Loaded two ways: index.html loads it as a script before app.js, which makes these
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

if (typeof module === 'object') module.exports = { formatStatus, shareMeter };
