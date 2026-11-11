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
// poll then drops the new marker.
let boardSeenTimer = null;
export function scheduleBoardSeen(id, count, latestCount) {
  if (boardSeenTimer || count <= boardSeen(id)) return;
  boardSeenTimer = setTimeout(() => {
    boardSeenTimer = null;
    const latest = latestCount(id);
    if (latest != null) saveBoardSeen(id, latest);
  }, 6000);
}
