// The Record day card, and the 7d total lines under Total cost and Total tokens.
import { getJson } from '../api.mjs';
import { formatCost, formatTokens, shortDate, localDateStr } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { createSequence } from '../guards.mjs';

// The Record day card's all-time value. Fetched once on load and once on
// Refresh, not on the 5s live poll or a range switch: /api/records reads the all-time
// and 7-day aggregates, so polling it on every tick would buy nothing. A failure,
// including a 500 whose body is { error }, resolves to null. Optional, like requestSessions.
function requestRecords() {
  return getJson('/api/records', { optional: true });
}

// Kept so /api/records resolving after the first render can redraw the card
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

// renderWeekTotals calls this on Today whenever recordsDay is not today's date.
// The early return below leaves recordsDay unset on purpose: while every consumer
// of /api/records is hidden nothing is fetched, and the next renderWeekTotals
// after one shows again tries once more.
export function refreshRecords() {
  if (!neededRequests(state.hiddenKeys, state.currentDays).has('records')) return;
  const day = localDateStr(new Date());
  recordsDay = day;
  const isLatest = recordsLoads.next();
  requestRecords().then((data) => {
    if (!isLatest()) return;
    // A failed request keeps the last good records, so the card keeps its value.
    if (data) {
      recordsData = data;
      recordsDataDay = day;
    }
    if (lastRecordDaily && shown('card-record')) renderRecord(lastRecordDaily);
    if (lastSummary) renderWeekTotals(lastSummary);
  });
}

// On Today, a second line under Total cost and Total tokens with the rolling
// 7 days: today's live totals plus the 6 days before it from /api/records.
// It shows a dash until /api/records has answered, which takes a few seconds
// on the first request after the server starts, while the row store reads the
// transcripts. Empty on every other range.
export function renderWeekTotals(summary) {
  lastSummary = summary;
  // A page left open on Today past midnight refetches once, on the first poll of
  // the new day. Refresh is hidden on Today, so nothing else would refetch.
  if (state.currentDays === 'today' && recordsDay !== localDateStr(new Date())) refreshRecords();
  const today = state.currentDays === 'today';
  const recentDays = recordsDataDay === localDateStr(new Date()) ? recordsData?.recentDays ?? null : null;
  const week = today
    ? rollingWeek(recentDays, localDateStr(new Date()), { cost: summary.totalCost, tokens: summary.totalTokens })
    : null;
  const title = today ? 'today and the 6 days before it' : '';
  const cost = document.getElementById('cardCostWeek');
  const tokens = document.getElementById('cardTokensWeek');
  const line = (value) => (today ? `7d total: ${week ? value : '—'}` : '');
  cost.textContent = line(week && formatCost(week.cost));
  tokens.textContent = line(week && formatTokens(week.tokens));
  cost.title = title;
  tokens.title = title;
}

// The value and date line show the all-time record: the day with the most tokens,
// with that day's cost. The note shows the record within the range on screen, also
// with its cost. Today's total grows on every live poll, and the range's aggregate can
// be newer than the all-time value that /api/records returns. So today's total or
// the range record replaces the fetched all-time record when it has more tokens.
export function renderRecord(daily) {
  lastRecordDaily = daily;

  const todayStr = localDateStr(new Date());
  // busiestDay over today's entries alone is today's total, with its cost.
  const today = busiestDay(daily.filter((d) => d.date.slice(0, 10) === todayStr));
  const rangeRecord = busiestDay(daily);

  let shownAllTime = recordsData && recordsData.allTime;
  if (shownAllTime) {
    if (today && today.tokens > shownAllTime.tokens) shownAllTime = today;
    if (rangeRecord && rangeRecord.tokens > shownAllTime.tokens) shownAllTime = rangeRecord;
  }

  document.getElementById('cardRecord').textContent = shownAllTime ? formatTokens(shownAllTime.tokens) : '—';
  document.getElementById('cardRecordDate').textContent =
    shownAllTime ? `${shortDate(shownAllTime.date)} · ${formatCost(shownAllTime.cost)}` : '';

  // On Today the range record is today itself, and Total tokens already shows
  // that number, so the note stays empty.
  let note = '';
  if (state.currentDays !== 'today' && rangeRecord) {
    note = shownAllTime && rangeRecord.date === shownAllTime.date
      ? 'this range holds the record'
      : `this range: ${formatTokens(rangeRecord.tokens)} · ${formatCost(rangeRecord.cost)} · ${shortDate(rangeRecord.date)}`;
  }
  document.getElementById('cardRecordNote').textContent = note;
}
