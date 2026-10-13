// What the sticky poll fetches: today's summary for the sticky bar and status strip,
// and the plan limits for the warning in the bar. getJson and requestLimits are
// passed in so the tests can count the requests. Neither promise rejects.
export function loadStickyData({ getJson, requestLimits }) {
  return Promise.all([getJson('/api/summary?days=today'), requestLimits()]).then(([summary, limits]) => ({ summary, limits }));
}
