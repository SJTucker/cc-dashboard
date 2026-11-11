// The sticky bar's record card, and the 7d lines under its cost and tokens.
import { getJson } from '../api.mjs';
import { formatCost, formatTokens, localDateStr } from '../format.mjs';
import { state } from '../state.mjs';
import { neededRequests } from '../visibility.mjs';
import { rollingWeek } from '../stats.mjs';
import { createSequence } from '../guards.mjs';
import { BOARDS } from '../highscores/boards.mjs';
import { stickyRecord } from '../highscores/view.mjs';
import { getMerged } from './highscores.mjs';

// The record card moves to the next board this often.
const ROTATE_MS = 6000;

// The 6 days before today for the 7d lines. Fetched once on load and once on
// Refresh, not on the 5s live poll or a range switch: /api/records reads the 7-day
// aggregate, so polling it on every tick would buy nothing. A failure, including a
// 500 whose body is { error }, resolves to null. Optional, like requestSessions.
function requestRecords() {
  return getJson('/api/records', { optional: true });
}

let lastSummary = null;
// The BOARDS index of the record the card shows.
let slot = 0;
// True while the pointer is over the card, so the record being read stays.
let paused = false;
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
    // A failed request keeps the last good recentDays.
    if (data) {
      recordsData = data;
      recordsDataDay = day;
    }
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

// The record card: the first place of one High scores board, from the boards with
// today's live values merged in (getMerged), so today shows as soon as it takes
// first place. Boards with no entry are skipped. Before the first /api/highscores
// answer, and while its payload is from an earlier date, the card shows a dash.
export function renderRecord() {
  const boards = getMerged();
  const label = document.getElementById('stickyRecordLabel');
  const value = document.getElementById('stickyRecord');
  const note = document.getElementById('stickyRecordDate');
  const n = BOARDS.length;
  let i = 0;
  while (i < n && !boards?.[BOARDS[(slot + i) % n].key]?.[0]) i += 1;
  if (i === n) {
    label.textContent = 'Records';
    value.textContent = '—';
    note.textContent = '';
    note.title = '';
    return;
  }
  slot = (slot + i) % n;
  const { key } = BOARDS[slot];
  const text = stickyRecord(key, boards[key][0], localDateStr(new Date()));
  label.textContent = text.label;
  value.textContent = text.value;
  note.textContent = text.note;
  // A long session title is cut off by CSS; the tooltip holds all of it.
  note.title = text.note;
}

function nextRecord() {
  slot = (slot + 1) % BOARDS.length;
  renderRecord();
}

// Starts the rotation. The card holds still while the pointer is over it, while
// the browser tab is hidden, and when the user asked for less motion. A click
// shows the next record at once, which is the only way to move it with less motion.
export function setupRecord() {
  const card = document.getElementById('stickyRecordCard');
  card.addEventListener('mouseenter', () => { paused = true; });
  card.addEventListener('mouseleave', () => { paused = false; });
  card.addEventListener('click', nextRecord);
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    nextRecord();
  });
  setInterval(() => {
    if (paused || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Until the boards arrive the card shows a dash, and moving on would skip the first record.
    if (getMerged()) nextRecord();
  }, ROTATE_MS);
}
