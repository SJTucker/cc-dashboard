import { state, shown } from './state.mjs';

import { createSequence } from './guards.mjs';

import { loadPanels } from './load.mjs';

import { getJson } from './api.mjs';

import { loadStickyData } from './sticky-poll.mjs';

import { escapeHtml } from './format.mjs';

import { spinnerNode } from './dom.mjs';

import { formatStatus } from './hud.mjs';
import { neededRequests } from './visibility.mjs';
import { createPoller } from './poll.mjs';
import { renderAttribution } from './panels/attribution.mjs';
import { renderCards } from './panels/cards.mjs';
import { ensureChanges, loadChanges, redrawChanges } from './panels/changes.mjs';
import { requestLimits, renderLimits, renderLimitsBanner } from './panels/limits.mjs';
import { renderModelDailyCharts, renderModelsPanel, setupModelMixToggle } from './panels/models.mjs';
import { loadPricesSource, setupPrices } from './panels/prices.mjs';
import { refreshRecords } from './panels/records.mjs';
import { setupHighscores, refreshHighscores, syncHighscores, resetWatch } from './panels/highscores.mjs';
import { requestReviews, renderReviews, reviewsMark, reviewsSince } from './panels/reviews.mjs';
import { renderRtk } from './panels/rtk.mjs';
import { requestSessions, renderSessions } from './panels/sessions.mjs';
import { renderSticky } from './panels/sticky.mjs';
import { renderTimeline, resetTimeline } from './panels/timeline.mjs';
import { renderTools } from './panels/tools.mjs';
import { renderContextFillers, renderLongestTurns } from './panels/fillers.mjs';
import { renderUsageCharts } from './panels/usage.mjs';
import { renderLinesChart } from './panels/lines.mjs';

import { setupCollapsibleRows, setupUsageGroupToggles } from './ui/collapse.mjs';
import { setupHiding } from './ui/hidden.mjs';
import { setupPanelLight } from './ui/panel-light.mjs';
import { setupRowOrder } from './ui/row-order.mjs';
import { setupTabs, showTab, rangeForTab, summaryPanelsFor } from './ui/tabs.mjs';

const LIVE_POLL_MS = 5000;
// While Today is shown, runLoad runs LIVE_POLL_MS after the previous run finished
// (createPoller in public/poll.mjs), so a slow scan delays the next poll instead of
// overlapping it. On any other range only the sticky bar polls (stickyPoller).
const livePoller = createPoller(() => runLoad(), LIVE_POLL_MS);
const stickyPoller = createPoller(() => loadStickyToday(), LIVE_POLL_MS);
// Signatures of the last rendered summary and the last rendered rtk response. A 5s
// poll that redraws unconditionally would tear down the SVG under the cursor and kill
// any open tooltip, so an unchanged response skips rendering entirely. The two are
// kept apart because the two requests settle at different times and each draws when
// its own request settles.
let lastSummarySignature = null;
let lastRtkSignature = null;

// Forces the next draw of every panel, for a change that the data does not show: a
// new range, a new width, a draw that threw.
function clearSignatures() {
  lastSummarySignature = null;
  lastRtkSignature = null;
}
// Numbers each fetchAll (see createSequence). A 30d request issued before a
// Today click lands after it, and is dropped.
const loads = createSequence();
// True once a draw of the current load threw and reportDrawError wrote its banner.
// renderMetaBanner leaves the banner alone while it is set, because the summary
// usually settles last and would otherwise hide the error. fetchAll resets it.
let drawErrorShown = false;
// The newest payload fetchAll collected once all five requests settled. redrawCharts
// draws from it after a resize, a hide or an expand, so a change of width makes no
// request. The range picker
// sets it to null, because renderPayload reads state.currentDays and would draw the old
// range's buckets with the new range's rules.
let lastPayload = null;
// True from the start of a fetchAll until the newest load's all-settled step. Between
// the first draw of a load and that step, lastPayload still holds the previous load,
// and a resize that redrew it would draw old data over the new. redrawCharts loads
// instead while this is set. A superseded load never clears it, so the newest load does.
let loadInFlight = false;

// Time of the last successful summary load, shown as Sync in the status strip.
let lastLoadedAt = null;

// Fills the status strip under the title. drawSummary calls it on every successful
// summary load, before drawSummaryPanels' unchanged-response check, so Sync moves on
// a quiet poll too. While live, the ring pulses once per call.
function renderStatusStrip(summary) {
  const status = formatStatus({
    loadedAt: lastLoadedAt,
    sessions: summary.sessions,
    apiCalls: summary.apiCalls,
  });
  document.getElementById('stripSync').textContent = status.sync;
  document.getElementById('stripSessions').textContent = status.sessions;
  document.getElementById('stripCalls').textContent = status.apiCalls;
  const ring = document.querySelector('#liveDot .live-ring');
  ring.classList.remove('ping');
  void ring.offsetWidth; // restarts the animation on the next add
  ring.classList.add('ping');
}

// A range switch, Refresh or first load can take seconds (a cold 30d scan takes
// ~1.9s, All longer), and the previous range's numbers stay on screen meanwhile.
// Those loads mark the page busy, but only after 250ms, so a ~0.17s Today load
// never flashes a spinner. The status element stays in the DOM so screen readers
// track it as a live region.
const BUSY_DELAY_MS = 250;
let busyTimer = null;

function setBusy(on) {
  clearTimeout(busyTimer);
  busyTimer = null;
  const main = document.getElementById('app');
  const status = document.getElementById('loadStatus');
  if (!on) {
    main.removeAttribute('aria-busy');
    status.replaceChildren();
    return;
  }
  busyTimer = setTimeout(() => {
    main.setAttribute('aria-busy', 'true');
    status.replaceChildren(spinnerNode(), document.createTextNode('Loading…'));
  }, BUSY_DELAY_MS);
}

// The Now tab polls the whole tab. The Analysis tab polls only the sticky bar and the
// plan limit warning, which show today on every tab.
function setPolling(onNow) {
  // A hidden tab polls nothing. The visibilitychange listener calls this again on show.
  if (document.hidden) {
    livePoller.stop();
    stickyPoller.stop();
    return;
  }
  if (onNow) {
    stickyPoller.stop();
    livePoller.start();
  } else {
    livePoller.stop();
    stickyPoller.start();
  }
}

// A hidden tab stops both pollers, so a background tab sends no requests. Showing the
// tab again refreshes once, unless a load is already running, then restarts the
// pollers for the current tab. enterTab sets state.tab, so a tab that is not Now never
// starts livePoller.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    livePoller.stop();
    stickyPoller.stop();
    return;
  }
  resetWatch();
  if (!loadInFlight) {
    if (state.tab === 'now') runLoad();
    else loadStickyToday();
  }
  setPolling(state.tab === 'now');
  syncHighscores();
});

// Every today summary draws the sticky bar and the status strip through here: the
// full load on Today, the sticky poll on other ranges. Sync moves on each one.
function drawSticky(data) {
  if (data.error) return;
  lastLoadedAt = Date.now();
  renderStatusStrip(data.summary);
  renderSticky(data);
}

// The sticky poll's run: today's summary for the bar, and /api/limits for the
// warning in it. createPoller requires a promise that never rejects, and neither
// request rejects (public/api.mjs). The range check drops a response that lands
// after a switch to Today, where the full load draws both.
function loadStickyToday() {
  return loadStickyData({ getJson, requestLimits }).then(({ summary, limits }) => {
    if (state.currentDays === 'today') return;
    drawSticky(summary);
    renderLimitsBanner(limits);
    // No summary draw runs on the High scores tab, so the first sticky poll ends
    // the "Loading…" lines (.first-load) that drawSummary ends on other tabs.
    if (state.currentDays === 'highscores') document.body.classList.remove('first-load');
  });
}

// The requests fetchAll skips when every panel they feed is hidden.
// resumeRequests loads the page again when one of them was skipped at the last
// load and is needed again.
const FETCH_ALL_OPTIONAL = ['rtk', 'sessions', 'reviews'];

// Issues the five requests and draws each panel as its own request settles
// (loadPanels in public/load.mjs). Resolves to { summary, rtk, limits, sessions,
// reviews } once all five have settled, or to null when a newer load started while
// this one waited.
async function fetchAll({ busy = false } = {}) {
  const isLatest = loads.next();
  drawErrorShown = false;
  loadInFlight = true;

  // Only user-started loads show the busy state. Whichever request is newest
  // clears it when it settles, even a quiet poll, because an older busy request's
  // response is dropped and would never clear it.
  if (busy) setBusy(true);

  // Every request is issued before any is awaited, so the summary never
  // waits on the others. None of the promises rejects (getJson never does). rtk
  // and limits are optional and resolve to null on failure, so an absent or
  // unreadable source hides its panel. A failed summary resolves to an error
  // payload, which drawSummaryPanels turns into the error banner after limits have
  // rendered (loadPanels keeps that order).
  const summaryRequest = getJson(`/api/summary?days=${state.currentDays}`);
  // A request whose every panel is hidden is skipped (see neededRequests in
  // visibility.mjs), and its panels render from null, as on a failed request.
  const needed = neededRequests(state.hiddenKeys, state.currentDays);
  const rtkRequest = needed.has('rtk')
    ? getJson(`/api/rtk?days=${state.currentDays}`, { optional: true })
    : Promise.resolve(null);

  const limitsRequest = requestLimits();
  // Only Today shows the sessions panels, so other ranges skip the request and
  // its Today scan.
  const sessionsRequest = needed.has('sessions') ? requestSessions() : Promise.resolve(null);
  const mark = reviewsMark();
  const reviewsRequest = needed.has('reviews') ? requestReviews(state.currentDays) : Promise.resolve(null);

  // The range rule runs before the first draw of this load.
  applyRangeRule();
  return loadPanels({
    requests: { summary: summaryRequest, rtk: rtkRequest, limits: limitsRequest, sessions: sessionsRequest, reviews: reviewsRequest },
    draws: {
      limits: drawLimitsPanels,
      // A dismiss or undo during the requests keeps the reviews on screen (reviewsSince).
      reviews: (reviews) => { if (shown('reviews')) renderReviews(reviewsSince(mark, reviews)); },
      sessions: drawSessionPanels,
      rtk: drawRtk,
      summary: drawSummary,
    },
    isLatest,
    reportDrawError,
    onAllSettled: ({ summary, rtk, limits, sessions, reviews }) => {
      setBusy(false);
      loadInFlight = false;
      lastPayload = { data: summary, rtk, limits, sessions, reviews: reviewsSince(mark, reviews) };
    },
  });
}

// Plan usage, the sessions and the timeline show on Today only. Their renderers set
// that, but a hidden panel's renderer is skipped, so the range rule is applied here
// too.
function applyRangeRule() {
  if (state.currentDays === 'today') return;
  for (const id of ['limitsPanel', 'sessionsPanel', 'timelinePanel']) document.getElementById(id).hidden = true;
}

// Plan usage describes right now: its "stale" suffix and its reset wording
// (today vs. a dated form) depend on the clock, not on the fetched numbers, so
// this runs on every settled response, including one the summary signature would
// treat as unchanged.
function drawLimitsPanels(limits) {
  if (shown('limits')) renderLimits(limits);
  renderLimitsBanner(limits);
}

function drawSessionPanels(sessions) {
  if (shown('sessions')) renderSessions(sessions);
  if (shown('timeline')) renderTimeline(sessions);
}

// The status banner after a summary loaded: hidden, or a note that the projects
// folder or its session files are missing.
function renderMetaBanner(meta) {
  if (drawErrorShown) return;
  const banner = document.getElementById('statusBanner');
  banner.hidden = true;
  if (!meta.dirExists) {
    banner.hidden = false;
    banner.innerHTML = `No Claude Code project logs found at <code>${escapeHtml(meta.projectsDir)}</code>. Use Claude Code at least once, or set <code>CLAUDE_CONFIG_DIR</code> if you use a custom location.`;
  } else if (meta.scannedFiles === 0) {
    banner.hidden = false;
    banner.textContent = 'Found the projects folder, but no session files yet.';
  }
}

// Draws everything the summary feeds on the tab shown: the banner, then the cards,
// charts, daily-by-model charts and tools on Analysis, or Where usage goes and
// Models on Now. lastSummarySignature is set on the last line, after every renderer
// has run. A renderer that throws therefore leaves the previous signature, and
// reportDrawError clears that one. The panel draw guards keep no key for a draw that
// threw, so those panels need no clearing.
function drawSummaryPanels(data) {
  if (data.error) {
    const banner = document.getElementById('statusBanner');
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${data.error}`;
    lastSummarySignature = null;
    return;
  }
  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models, data.longestTurns, data.contextFillers?.totals]);
  if (signature === lastSummarySignature) return;
  renderMetaBanner(data.meta);
  const panels = summaryPanelsFor(state.tab);
  if (panels.includes('cards')) renderCards(data);
  if (panels.includes('usage')) renderUsageCharts(data);
  if (panels.includes('lines')) renderLinesChart(data);
  if (panels.includes('models')) renderModelsPanel(data);
  if (panels.includes('modelDaily')) renderModelDailyCharts(data);
  if (panels.includes('attribution')) renderAttribution(data);
  if (panels.includes('tools') && shown('tools')) {
    renderTools(data.tools || [], data.toolTotals);
    renderContextFillers(data.contextFillers);
    renderLongestTurns(data.longestTurns);
  }
  lastSummarySignature = signature;
}

// The summary request's draw. The first one of the page's life, a failure included,
// ends the "Loading…" lines (.first-load in css/base.css). On Today the summary is
// today's, so it draws the sticky bar too.
function drawSummary(data) {
  document.body.classList.remove('first-load');
  if (state.currentDays === 'today') drawSticky(data);
  drawSummaryPanels(data);
}

// The rtk request's draw. The rtk panels depend on the summary of the rtk response only.
function drawRtk(rtk) {
  const signature = JSON.stringify([rtk && rtk.summary]);
  if (signature === lastRtkSignature) return;
  renderRtk(rtk);
  lastRtkSignature = signature;
}

// Draws every panel from a payload that fetchAll collected, with no request. Used for
// a redraw: a resize, a hidden-panel toggle or an expand. It does not move lastLoadedAt
// or the status strip, which belong to a load.
function renderPayload({ data, rtk, limits, sessions, reviews }) {
  applyRangeRule();
  drawLimitsPanels(limits);
  drawSessionPanels(sessions);
  if (shown('reviews')) renderReviews(reviews);
  drawSummaryPanels(data);
  drawRtk(rtk);
}

// A renderer that throws would otherwise leave the page half drawn with no message.
// The banner names the error, and clearing the signatures makes the next poll draw
// every panel again.
function reportDrawError(err) {
  // Must never throw: loadPanels calls it from a catch, and a throw here would skip
  // the all-settled step, so the busy state would never clear. Each step is guarded
  // on its own so one failure does not stop the others.
  console.error(err);
  drawErrorShown = true;
  clearSignatures();
  try {
    const banner = document.getElementById('statusBanner');
    banner.hidden = false;
    banner.textContent = `Couldn't draw the page: ${err?.message ?? err}`;
  } catch { /* the banner is missing or err has a throwing message getter */ }
  try { resetTimeline(); } catch { /* the timeline is redrawn by the next load */ }
}

// Every load goes through runLoad, so no caller leaves a rejection unhandled.
// runLoad never rejects, which createPoller requires (public/poll.mjs): a
// rejected run would end the live poll chain. reportDrawError only writes text
// to #statusBanner and never throws, so the catch cannot throw.
function runLoad(options) {
  // The High scores tab has no range summary to load or draw. A load from the
  // previous tab still in flight is made stale, so it draws nothing, and it can no
  // longer clear the busy state or loadInFlight, so they are cleared here.
  if (state.currentDays === 'highscores') {
    loads.next();
    loadInFlight = false;
    setBusy(false);
    return Promise.resolve();
  }
  return fetchAll(options).catch(reportDrawError);
}

function syncRangeButtons() {
  for (const b of document.querySelectorAll('#rangePicker button')) {
    b.classList.toggle('active', b.dataset.days === String(state.analysisDays));
  }
}

// The range picker is on the Analysis tab only, so a pick never means Today.
document.getElementById('rangePicker').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-days]');
  if (!btn) return;
  const value = btn.dataset.days;
  state.analysisDays = value === 'all' ? value : Number(value);
  state.currentDays = state.analysisDays;
  syncRangeButtons();
  clearSignatures(); // the bucket keys change, so force a redraw
  lastPayload = null;
  redrawChanges();
  runLoad({ busy: true });
});

// Shows a tab and loads it. Now is the Today range and polls; Analysis loads its
// range once and polls only the sticky bar. A request that the old tab skipped and
// the new tab needs starts here. Setup changes load once, through ensureChanges,
// which redraws from the loaded report on later visits. The price source reloads on
// each switch to Now, because the Analysis tab never needs prices. The load runs
// after showTab, so every chart is drawn at its visible width. The first call has
// no old tab: state starts on Now's range, which would hide Now's own requests.
let tabEntered = false;
function enterTab(tab) {
  const before = tabEntered ? neededRequests(state.hiddenKeys, state.currentDays) : new Set();
  tabEntered = true;
  state.tab = tab;
  state.currentDays = rangeForTab(tab, state.analysisDays);
  showTab(tab);
  syncRangeButtons();
  clearSignatures();
  resetTimeline();
  lastPayload = null;
  setPolling(tab === 'now');
  syncHighscores();
  if (tab === 'highscores') refreshHighscores();
  const after = neededRequests(state.hiddenKeys, state.currentDays);
  if (after.has('changes') && !before.has('changes')) ensureChanges();
  if (after.has('prices') && !before.has('prices')) loadPricesSource();
  if (tab !== 'now') loadStickyToday();
  runLoad({ busy: true });
}

// Everything the Refresh button re-fetches. Applying prices calls it too, because
// costs are computed in the server's scan and the server has just dropped that scan.
function reloadAll() {
  clearSignatures();
  refreshRecords();
  refreshHighscores();
  runLoad({ busy: true });
  loadChanges();
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  setBusy(true);
  // A rejected refresh (e.g. the server is down) must not skip runLoad in reloadAll:
  // its failed summary request is what clears busy and shows the error banner.
  await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
  reloadAll();
});

// Draws every chart again at the current widths, from lastPayload and with no
// request. It loads instead when there is no payload yet, or when resumeRequests
// passes refetch because a request skipped at the last load is needed again.
function redrawCharts({ changes = true, refetch = false } = {}) {
  if (state.currentDays === 'highscores') return; // no charts on the High scores tab
  clearSignatures(); // the width changed, so the same data still needs redrawing
  resetTimeline();
  if (refetch || !lastPayload || loadInFlight) {
    runLoad();
  } else {
    try {
      renderPayload(lastPayload);
    } catch (err) {
      reportDrawError(err);
    }
  }
  if (changes) redrawChanges();
}

// A resize redraws the charts at the new width, 150 ms after the last resize event.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawCharts, 150);
});

// What to load after showing panels whose requests hiding had skipped. rtk,
// sessions and reviews come from fetchAll, and lastPayload holds null for a
// skipped one, so when one of those resumes, redrawCharts loads the page again.
function resumeRequests(resumed) {
  if (resumed('records')) {
    refreshRecords();
    refreshHighscores();
  }
  if (resumed('prices')) loadPricesSource();
  // loadChanges renders the Setup changes panel itself when it finishes.
  if (resumed('changes')) loadChanges();
  redrawCharts({ changes: !resumed('changes'), refetch: FETCH_ALL_OPTIONAL.some(resumed) });
}

// setupRowOrder runs first: setupCollapsibleRows reads the data-row-key it sets.
setupRowOrder();
// A chart drawn while its row was collapsed has the 200px fallback width. The
// changes charts are redrawn only when the expanded row holds them.
setupCollapsibleRows({
  onExpand: (row) => redrawCharts({ changes: row.id === 'beforeAfterPanel' }),
});
// The other panel of a pair widens to the full row.
setupHiding({ onWidthChange: () => redrawCharts({ changes: false }), onResume: resumeRequests });
setupPanelLight();
setupUsageGroupToggles();
setupModelMixToggle();
setupPrices({ onApplied: reloadAll });
refreshRecords();
setupHighscores();
refreshHighscores();
// Runs enterTab once for the hash the page opened with, then on each hash change.
setupTabs(enterTab);
