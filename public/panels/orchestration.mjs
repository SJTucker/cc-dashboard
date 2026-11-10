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
