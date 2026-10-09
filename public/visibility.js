'use strict';

// Loaded two ways: index.html loads it as a script before main.mjs, which makes
// these names globals, and the tests load it with require().

// The optional requests and the hide keys of the panels and cards each one feeds.
// A request is skipped when every key it feeds is hidden. /api/summary and
// /api/limits are not listed, because they are always fetched: the summary feeds
// most of the page, and the limits banner shows on every range and has no "x".
const REQUEST_CONSUMERS = {
  changes: ['sessionStart', 'beforeAfter'],
  rtk: ['rtkDaily', 'rtkCommands'],
  sessions: ['sessions', 'timeline'],
  reviews: ['reviews'],
  records: ['card-record'],
  prices: ['costByModel'],
};

// The hidden keys saved in localStorage. Anything that is not a JSON list gives
// an empty list, and entries that are not strings are dropped.
function parseHidden(raw) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

// The optional requests that still have a visible panel or card. The sessions
// request is made on Today only, where its two panels show. On Today the Total
// cost and Total tokens cards show the 7d total lines, which also come from
// /api/records.
function neededRequests(hidden, range) {
  const today = range === 'today';
  const needed = new Set();
  for (const [request, keys] of Object.entries(REQUEST_CONSUMERS)) {
    if (request === 'sessions' && !today) continue;
    const consumers = request === 'records' && today ? [...keys, 'card-cost', 'card-tokens'] : keys;
    if (consumers.some((key) => !hidden.has(key))) needed.add(request);
  }
  return needed;
}

if (typeof module === 'object') module.exports = { REQUEST_CONSUMERS, parseHidden, neededRequests };
