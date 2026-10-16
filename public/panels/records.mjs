// The sticky bar's Record day, and the 7d lines under its cost and tokens.
import { getJson } from '../api.mjs';
import { formatCost, formatTokens, shortDate, localDateStr } from '../format.mjs';
import { state } from '../state.mjs';
import { neededRequests } from '../visibility.mjs';
import { busiestDay, rollingWeek } from '../stats.mjs';
import { createSequence } from '../guards.mjs';

// The sticky bar's Record day, the all-time value. Fetched once on load and once on
// Refresh, not on the 5s live poll or a range switch: /api/records reads the
// all-time and 7-day aggregates, so polling it on every tick would buy nothing. A
// failure, including a 500 whose body is { error }, resolves to null. Optional,
// like requestSessions.
function requestRecords() {
  return getJson('/api/records', { optional: true });
}

// Kept so /api/records resolving after the first render can redraw Record day
// with the same daily data the last summary produced.
let lastRecordDaily = null;
let lastSummary = null;
let recordsData = null;
// The local date the last /api/records request was made on. recentDays holds the
// 6 days before that date, so after midnight it is missing yesterday.
let recordsDay = null;
// The local date recordsData was fetched for. renderWeekTotals ignores recentDays
// from an earlier date, because rollingWeek would sum the wrong 6 days.
let recordsDataDay = null;
// Numbers each /api/records request, so a slow first load cannot overwrite a
// later Refresh.
const recordsLoads = createSequence();

// renderWeekTotals calls this, on both tabs, whenever recordsDay is not today's date.
// The sticky bar is the only consumer of /api/records and cannot be hidden, so
// neededRequests always includes it. The check stays as the one place that decides
// what the page fetches.
export function refreshRecords() {
  if (!neededRequests(state.hiddenKeys, state.tab).has('records')) return;
  const day = localDateStr(new Date());
  recordsDay = day;
  const isLatest = recordsLoads.next();
  requestRecords().then((data) => {
    if (!isLatest()) return;
    // A failed request keeps the last good records, so Record day keeps its value.
    if (data) {
      recordsData = data;
      recordsDataDay = day;
    }
    if (lastRecordDaily) renderRecord(lastRecordDaily);
    if (lastSummary) renderWeekTotals(lastSummary);
  });
}

// The 7d line under the sticky cost and tokens: today's live totals plus the 6
// days before it from /api/records. It shows a dash until /api/records has
// answered, which takes a few seconds on the first request after the server starts.
// summary is always today's (sticky.mjs).
export function renderWeekTotals(summary) {
  lastSummary = summary;
  // A page left open past midnight refetches once, on the first poll of the new day.
  if (recordsDay !== localDateStr(new Date())) refreshRecords();
  const recentDays = recordsDataDay === localDateStr(new Date()) ? recordsData?.recentDays ?? null : null;
  const week = rollingWeek(recentDays, localDateStr(new Date()), { cost: summary.totalCost, tokens: summary.totalTokens });
  const cost = document.getElementById('stickyCostWeek');
  const tokens = document.getElementById('stickyTokensWeek');
  cost.textContent = `7d ${week ? formatCost(week.cost) : '—'}`;
  tokens.textContent = `7d ${week ? formatTokens(week.tokens) : '—'}`;
  cost.title = 'today and the 6 days before it';
  tokens.title = cost.title;
}

// The all-time record: the day with the most tokens, with its cost. Today's total
// grows on every poll and can pass the fetched record, so it replaces the record
// when it has more tokens. daily is today's hourly buckets.
export function renderRecord(daily) {
  lastRecordDaily = daily;
  const todayStr = localDateStr(new Date());
  const today = busiestDay(daily.filter((d) => d.date.slice(0, 10) === todayStr));
  let record = recordsData && recordsData.allTime;
  if (record && today && today.tokens > record.tokens) record = today;
  document.getElementById('stickyRecord').textContent = record ? formatTokens(record.tokens) : '—';
  document.getElementById('stickyRecordDate').textContent = record ? `${shortDate(record.date)} · ${formatCost(record.cost)}` : '';
}
