import { state, shown } from './state.mjs';

import { createSequence } from './guards.mjs';

import { loadPanels } from './load.mjs';

import { getJson } from './api.mjs';

import { escapeHtml } from './format.mjs';

import { spinnerNode } from './dom.mjs';

import { renderAttribution } from './panels/attribution.mjs';
import { renderCards } from './panels/cards.mjs';
import { loadChanges, redrawChanges } from './panels/changes.mjs';
import { requestLimits, renderLimits, renderLimitsBanner } from './panels/limits.mjs';
import { renderModels, setupModelMixToggle } from './panels/models.mjs';
import { loadPricesSource, setupPrices } from './panels/prices.mjs';
import { refreshRecords } from './panels/records.mjs';
import { requestReviews, renderReviews, reviewsMark, reviewsSince } from './panels/reviews.mjs';
import { renderRtk } from './panels/rtk.mjs';
import { requestSessions, renderSessions } from './panels/sessions.mjs';
import { renderTimeline, resetTimeline } from './panels/timeline.mjs';
import { renderTools } from './panels/tools.mjs';
import { renderUsageCharts } from './panels/usage.mjs';

import { setupCollapsibleRows, setupUsageGroupToggles } from './ui/collapse.mjs';
import { setupHiding } from './ui/hidden.mjs';
import { setupPanelLight } from './ui/panel-light.mjs';
import { setupRowOrder } from './ui/row-order.mjs';

const LIVE_POLL_MS = 5000;
// While live, runLoad runs LIVE_POLL_MS after the previous run finished
// (createPoller in public/poll.js), so a slow scan delays the next poll instead of
// overlapping it.
const livePoller = createPoller(() => runLoad(), LIVE_POLL_MS);
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
  const active = document.querySelector('#rangePicker button.active');
  const status = formatStatus({
    loadedAt: lastLoadedAt,
    range: active ? active.textContent : '',
    sessions: summary.sessions,
    apiCalls: summary.apiCalls,
  });
  document.getElementById('stripSync').textContent = status.sync;
  document.getElementById('stripRange').textContent = status.range;
  document.getElementById('stripSessions').textContent = status.sessions;
  document.getElementById('stripCalls').textContent = status.apiCalls;
  if (!livePoller.running) return;
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

function setLive(on) {
  if (on) livePoller.start();
  else livePoller.stop();
  document.getElementById('liveDot').classList.toggle('is-off', !on);
  document.querySelector('#liveDot .live-text').textContent = on ? 'Link live' : 'Paused';
  // A live range re-scans every 5 seconds, so a manual refresh has nothing to do.
  document.getElementById('refreshBtn').hidden = on;
}

// On Today the summary cards sit in the sticky header in a compact form, so they
// stay in view while scrolling. Other ranges show them as full cards in the page.
// The one #summaryCards element moves between the two slots, so every card id
// stays unique and drawSummaryPanels fills it the same way wherever it is.
function placeSummaryCards() {
  const cards = document.getElementById('summaryCards');
  const today = state.currentDays === 'today';
  document.getElementById(today ? 'headerCards' : 'mainCards').appendChild(cards);
  cards.classList.toggle('cards-compact', today);
  // Hidden off Today, so the empty slot cannot wrap onto a line of its own.
  document.getElementById('headerCards').hidden = !today;
  // renderCards hides these two on Today too, but only once the load finishes.
  // Hiding them here keeps the old range's values out of the header meanwhile.
  if (today) {
    document.getElementById('burnCard').hidden = true;
    document.getElementById('projectionCard').hidden = true;
  }
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
  // visibility.js), and its panels render from null, as on a failed request.
  const needed = neededRequests(state.hiddenKeys, state.currentDays);
  const rtkRequest = needed.has('rtk')
    ? getJson(`/api/rtk?days=${state.currentDays}`, { optional: true })
    : Promise.resolve(null);

  const limitsRequest = requestLimits();
  // Only Today shows the sessions panels, so other ranges skip the request and
  // its Today scan.
  const sessionsRequest = needed.has('sessions') ? requestSessions() : Promise.resolve(null);
  const mark = reviewsMark();
  const reviewsRequest = needed.has('reviews') ? requestReviews() : Promise.resolve(null);

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

// Draws everything the summary feeds: the banner, cards, charts, models, attribution
// and tools. lastSummarySignature is set on the last line, after every renderer has
// run. A renderer that throws therefore leaves the previous signature, and
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
  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models]);
  if (signature === lastSummarySignature) return;
  renderMetaBanner(data.meta);
  renderCards(data);
  renderUsageCharts(data);
  renderModels(data);
  renderAttribution(data);
  if (shown('tools')) renderTools(data.tools || [], data.toolTotals);
  lastSummarySignature = signature;
}

// The summary request's draw. The first one of the page's life, a failure included,
// ends the "Loading…" lines (.first-load in style.css). Sync moves on every successful
// load, a quiet poll included, so lastLoadedAt is set before the status strip reads it.
function drawSummary(data) {
  document.body.classList.remove('first-load');
  if (!data.error) {
    lastLoadedAt = Date.now();
    renderStatusStrip(data.summary);
  }
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
// runLoad never rejects, which createPoller requires (public/poll.js): a
// rejected run would end the live poll chain. reportDrawError only writes text
// to #statusBanner and never throws, so the catch cannot throw.
function runLoad(options) {
  return fetchAll(options).catch(reportDrawError);
}

document.getElementById('rangePicker').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-days]');
  if (!btn) return;
  document.querySelectorAll('#rangePicker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.days;
  state.currentDays = value === 'all' || value === 'today' ? value : Number(value);
  placeSummaryCards();
  clearSignatures(); // the bucket keys change, so force a redraw
  lastPayload = null;
  setLive(state.currentDays === 'today');
  redrawChanges();
  runLoad({ busy: true });
});

// Everything the Refresh button re-fetches. Applying prices calls it too, because
// costs are computed in the server's scan and the server has just dropped that scan.
function reloadAll() {
  clearSignatures();
  refreshRecords();
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
  if (resumed('records')) refreshRecords();
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
placeSummaryCards();
setLive(state.currentDays === 'today');
refreshRecords();
runLoad({ busy: true });
loadChanges();
loadPricesSource();
