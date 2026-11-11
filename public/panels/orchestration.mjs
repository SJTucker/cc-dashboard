// The Orchestration tab's requests and pure helpers. No DOM here, so node can
// import it (test/modules-load.test.js).
import { getJson } from '../api.mjs';

// How often the open Orchestration tab refreshes its detail.
export const ORCH_POLL_MS = 3000;

// { installed, orchestrations } or null on failure. opts is passed to getJson.
export function requestOrchestrations(opts = {}) {
  return getJson('/api/orchestrations', { optional: true, ...opts });
}

// One orchestration's detail, or null on failure (400, 404, network).
export function requestOrchestration(id, opts = {}) {
  return getJson('/api/orchestrations/' + encodeURIComponent(id), { optional: true, ...opts });
}

// The saved id when it is listed, else the first entry (the server sorts the
// list), else null.
export function pickSelected(list, savedId) {
  if (list.some((entry) => entry.id === savedId)) return savedId;
  return list[0]?.id ?? null;
}

// The number of orchestrations with a live session.
export function liveCount(list) {
  return list.filter((entry) => entry.live).length;
}

// POSTs a JSON body. Resolves to { ok, status, data }: data is the parsed answer, or
// null when the body is not JSON or no answer arrived (status 0). It never rejects.
async function postJson(url, body, fetchImpl = (...args) => fetch(...args)) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// The owner's board post. 201 answers with the post as stored.
export function sendBoardPost(id, { title, body }, { fetchImpl } = {}) {
  return postJson(`/api/orchestrations/${encodeURIComponent(id)}/board`, { title, body }, fetchImpl);
}

// A steer for one worker. 202 answers with { id }, the request id.
export function sendSteer(id, { agentId, text }, { fetchImpl } = {}) {
  return postJson(`/api/orchestrations/${encodeURIComponent(id)}/steer`, { agentId, text }, fetchImpl);
}

// How many board posts of an orchestration the viewer has seen, kept per
// orchestration in localStorage. Posts beyond it get the new marker.
const BOARD_SEEN_PREFIX = 'cc-dashboard:board-seen:';

export function boardSeen(id) {
  try {
    return Number(localStorage.getItem(BOARD_SEEN_PREFIX + id)) || 0;
  } catch {
    return 0;
  }
}

export function saveBoardSeen(id, count) {
  try {
    localStorage.setItem(BOARD_SEEN_PREFIX + id, String(count));
  } catch {
    // Storage can be blocked. Every post then shows as new on the next visit.
  }
}

// Stores the board count 6 s after a render that showed unseen posts. The next
// poll then drops the new marker. Each orchestration has its own pending timer, so
// a switch within 6 s does not drop the first one's update.
const seenTimers = new Map();
export function scheduleBoardSeen(id, count, delay = 6000) {
  if (seenTimers.has(id) || count <= boardSeen(id)) return;
  seenTimers.set(id, setTimeout(() => {
    seenTimers.delete(id);
    saveBoardSeen(id, Math.max(count, boardSeen(id)));
  }, delay));
}

// The selected orchestration id, kept in localStorage across page loads.
const SELECTED_KEY = 'cc-dashboard:orchestration';
let lastStoredId = null;

export function savedOrchestrationId() {
  try {
    lastStoredId = localStorage.getItem(SELECTED_KEY);
    return lastStoredId;
  } catch {
    return null;
  }
}

// Writes only when the id differs from the last one stored, so a poll that selects
// the same id writes nothing.
export function saveOrchestrationId(id) {
  if (!id || id === lastStoredId) return;
  try {
    localStorage.setItem(SELECTED_KEY, id);
    lastStoredId = id;
  } catch {
    // Storage can be blocked. The selection then lasts for this page view.
  }
}

// Milliseconds between startup attempts after a failed first request: 5 s, 15 s, 60 s,
// then every 5 min.
export const ORCH_RETRY_MS = [5000, 15000, 60000, 300000];

const GLOBAL_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

// Decides whether the Orchestration tab exists. start() asks /api/orchestrations.
// A null answer (network error, 5xx) says nothing about the skill, so the request
// is retried on ORCH_RETRY_MS. A real { installed: false } answer calls onRemoved
// and ends all calls. A later { installed: false } passed to accept() does the same.
// A hidden page sends no retry: resume() sends the pending one when it shows again.
export function createOrchestrationGate({ request = requestOrchestrations, onInstalled, onRemoved, isHidden = () => false, timers = GLOBAL_TIMERS }) {
  let installed = false;
  let settled = false;
  let attempt = 0;
  let timer = null;
  let retryDue = false;

  async function ask() {
    timer = null;
    retryDue = false;
    const body = await request();
    if (settled) return;
    if (body == null) {
      timer = timers.setTimeout(() => {
        timer = null;
        if (isHidden()) retryDue = true;
        else ask();
      }, ORCH_RETRY_MS[Math.min(attempt++, ORCH_RETRY_MS.length - 1)]);
      return;
    }
    settled = true;
    if (body.installed) {
      installed = true;
      onInstalled(body);
    } else {
      onRemoved();
    }
  }

  return {
    start: ask,
    resume() {
      if (retryDue && !settled) {
        timers.clearTimeout(timer);
        ask();
      }
    },
    // A later list answer. Only a real { installed: false } removes the tab.
    accept(body) {
      if (!installed || !body || body.installed) return;
      installed = false;
      onRemoved();
    },
    get installed() { return installed; },
    get settled() { return settled; },
  };
}

// Starts the detail poller only for an installed skill, on the Orchestration tab, on a
// shown page. In every other state it stops it, so no request goes out.
export function syncOrchestrationPoller(poller, { installed, tab, hidden }) {
  if (installed && tab === 'orchestration' && !hidden) poller.start();
  else poller.stop();
}

// Takes the Orchestration tab away after the server said the skill is not installed:
// hides the tab button and the live badge, stops the poller, clears the page state
// (clearState) and sends #orchestration back to #now.
export function removeOrchestrationTab({ tabButton, badge, poller, location, onTab, clearState }) {
  poller.stop();
  clearState();
  tabButton.hidden = true;
  badge.hidden = true;
  if (onTab) location.hash = 'now';
}
