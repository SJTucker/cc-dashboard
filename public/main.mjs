import { state, shown } from './state.mjs';

import { createSequence } from './guards.mjs';

import { getJson } from './api.mjs';

import { escapeHtml } from './format.mjs';

import { spinnerNode } from './dom.mjs';

import { renderAttribution } from './panels/attribution.mjs';
import { renderCards } from './panels/cards.mjs';
import { loadChanges, redrawChanges } from './panels/changes.mjs';
import { requestLimits, renderLimits, renderLimitsBanner } from './panels/limits.mjs';
import { renderModels } from './panels/models.mjs';
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
// Signature of the last rendered payload. A 5s poll that redraws unconditionally
// would tear down the SVG under the cursor and kill any open tooltip, so an
// unchanged payload skips rendering entirely.
let lastSignature = null;
// Numbers each fetchAll (see createSequence). A 30d request issued before a
// Today click lands after it, and is dropped.
const loads = createSequence();
// The newest payload fetchAll returned. redrawCharts draws from it after a resize,
// a hide or an expand, so a change of width makes no request. The range picker
// sets it to null, because renderPayload reads state.currentDays and would draw the old
// range's buckets with the new range's rules.
let lastPayload = null;

// Time of the last successful summary load, shown as Sync in the status strip.
let lastLoadedAt = null;

// Fills the status strip under the title. loadAndRender calls it on every
// successful summary load, before renderPayload's unchanged-payload check, so Sync
// moves on a quiet poll too. While live, the ring pulses once per call.
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
// stays unique and renderPayload fills it the same way wherever it is.
function placeSummaryCards() {
  const cards = document.getElementById('summaryCards');
  const today = state.currentDays === 'today';
  document.getElementById(today ? 'headerCards' : 'mainCards').appendChild(cards);
  cards.classList.toggle('cards-compact', today);
  // Hidden off Today, so the empty slot cannot wrap onto a line of its own.
  document.getElementById('headerCards').hidden = !today;
  // renderPayload hides these two on Today too, but only once the load finishes.
  // Hiding them here keeps the old range's values out of the header meanwhile.
  if (today) {
    document.getElementById('burnCard').hidden = true;
    document.getElementById('projectionCard').hidden = true;
  }
}

// The optional requests fetchAll makes. resumeRequests loads the page again when
// one of them was skipped at the last load and is needed again.
const FETCH_ALL_OPTIONAL = ['rtk', 'sessions', 'reviews'];

// Issues the five requests and waits for all of them. Returns { data, rtk, limits,
// sessions, reviews }, or null when a newer load started while this one waited.
async function fetchAll({ busy = false } = {}) {
  const isLatest = loads.next();

  // Only user-started loads show the busy state. Whichever request is newest
  // clears it when it settles, even a quiet poll, because an older busy request's
  // response is dropped below and would never clear it.
  if (busy) setBusy(true);

  // Every request is issued before any is awaited, so the summary never
  // waits on the others. None of the promises rejects (getJson never does). rtk and limits
  // are optional and resolve to null on failure, so an absent or unreadable source
  // hides its panel. A failed summary resolves to an error payload, which
  // renderPayload turns into the error banner after limits have rendered.
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

  const [data, rtk, limits, sessions, reviews] = await Promise.all([summaryRequest, rtkRequest, limitsRequest, sessionsRequest, reviewsRequest]);
  if (!isLatest()) return null; // a newer request superseded this response
  setBusy(false);
  if (!data.error) lastLoadedAt = Date.now();
  // A dismiss or undo during the requests keeps the reviews on screen (reviewsSince).
  lastPayload = { data, rtk, limits, sessions, reviews: reviewsSince(mark, reviews) };
  return lastPayload;
}

// Plan usage describes right now: its "stale" suffix and its reset wording
// (today vs. a dated form) depend on the clock, not on the fetched numbers, so
// this has to run on every settled response. That includes one whose summary
// failed, and one the payload signature would otherwise treat as unchanged.
// These three panels show on Today only. Their renderers set that, but a hidden
// panel's renderer is skipped, so the range rule is applied here too.
function renderNowPanels({ limits, sessions, reviews }) {
  if (state.currentDays !== 'today') {
    for (const id of ['limitsPanel', 'sessionsPanel', 'timelinePanel']) document.getElementById(id).hidden = true;
  }
  if (shown('limits')) renderLimits(limits);
  if (shown('sessions')) renderSessions(sessions);
  if (shown('timeline')) renderTimeline(sessions);
  if (shown('reviews')) renderReviews(reviews);
  renderLimitsBanner(limits);
}

// The status banner after a summary loaded: hidden, or a note that the projects
// folder or its session files are missing.
function renderMetaBanner(meta) {
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

// Draws a payload from fetchAll, one call per section. lastSignature is set on the
// last line, after every renderer has run. A renderer that throws therefore
// leaves the previous signature, and reportDrawError clears that one. The panel
// draw guards keep no key for a draw that threw, so those panels need no clearing.
function renderPayload(payload) {
  const { data, rtk } = payload;
  renderNowPanels(payload);
  if (data.error) {
    const banner = document.getElementById('statusBanner');
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${data.error}`;
    lastSignature = null;
    return;
  }
  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models, rtk && rtk.summary]);
  if (signature === lastSignature) return;
  renderMetaBanner(data.meta);
  renderCards(data);
  renderUsageCharts(data);
  renderModels(data);
  renderAttribution(data);
  if (shown('tools')) renderTools(data.tools || []);
  renderRtk(rtk);
  lastSignature = signature;
}

async function loadAndRender(options) {
  const payload = await fetchAll(options);
  if (!payload) return;
  // Sync moves on every successful load, a quiet poll included, so the strip is
  // filled before renderPayload's unchanged-payload check.
  if (!payload.data.error) renderStatusStrip(payload.data.summary);
  renderPayload(payload);
}

// A renderer that throws would otherwise reject loadAndRender with nothing to catch
// it, and leave the page half drawn with no message. The banner names the error,
// and clearing lastSignature makes the next poll draw every panel again.
function reportDrawError(err) {
  console.error(err);
  const banner = document.getElementById('statusBanner');
  banner.hidden = false;
  banner.textContent = `Couldn't draw the page: ${err?.message ?? err}`;
  lastSignature = null;
  resetTimeline();
}

// Every load goes through runLoad, so no caller leaves a rejection unhandled.
// runLoad never rejects, which createPoller requires (public/poll.js): a
// rejected run would end the live poll chain. reportDrawError only writes text
// to #statusBanner, which index.html always has, so the catch cannot throw.
function runLoad(options) {
  return loadAndRender(options).catch(reportDrawError);
}

document.getElementById('rangePicker').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-days]');
  if (!btn) return;
  document.querySelectorAll('#rangePicker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.days;
  state.currentDays = value === 'all' || value === 'today' ? value : Number(value);
  placeSummaryCards();
  lastSignature = null; // the bucket keys change, so force a redraw
  lastPayload = null;
  setLive(state.currentDays === 'today');
  redrawChanges();
  runLoad({ busy: true });
});

// Everything the Refresh button re-fetches. Applying prices calls it too, because
// costs are computed in the server's scan and the server has just dropped that scan.
function reloadAll() {
  lastSignature = null;
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
// request. It loads instead when there is no payload yet, or when resumeRequests passes
// refetch because a request skipped at the last load is needed again.
function redrawCharts({ changes = true, refetch = false } = {}) {
  lastSignature = null; // the width changed, so the same data still needs redrawing
  resetTimeline();
  if (refetch || !lastPayload) {
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
  // loadChanges renders both changes panels itself when it finishes.
  if (resumed('changes')) loadChanges();
  redrawCharts({ changes: !resumed('changes'), refetch: FETCH_ALL_OPTIONAL.some(resumed) });
}

// setupRowOrder runs first: setupCollapsibleRows reads the data-row-key it sets.
setupRowOrder();
// A chart drawn while its row was collapsed has the 200px fallback width. The
// changes charts are redrawn only when the expanded row holds them.
setupCollapsibleRows({
  onExpand: (row) => redrawCharts({ changes: row.id === 'sessionStartPanel' || row.id === 'beforeAfterPanel' }),
});
// The other panel of a pair widens to the full row.
setupHiding({ onWidthChange: () => redrawCharts({ changes: false }), onResume: resumeRequests });
setupPanelLight();
setupUsageGroupToggles();
setupPrices({ onApplied: reloadAll });
placeSummaryCards();
setLive(state.currentDays === 'today');
refreshRecords();
runLoad({ busy: true });
loadChanges();
loadPricesSource();
