// Numbers the page shares with the server. Each comment names the server
// constant it equals; test/front-end-constants.test.js fails when they differ.

// Rows drawn per tool list and per rtk command list. lib/rtk.js DETAIL_LIMIT
// caps the rtk detail rows the server sends at the same number.
export const DETAIL_LIMIT = 12;

// A session counts as live while its last call is this recent.
// lib/sessions.js LIVE_WINDOW_MS.
export const LIVE_WINDOW_MS = 10 * 60 * 1000;

// Reviews per page of the closed list in the Session reviews panel.
// lib/review.js CLOSED_PAGE_SIZE.
export const REVIEWS_CLOSED_PAGE = 10;

// The limits banner shows once a plan window reaches this percent. The server
// has no matching constant.
export const LIMIT_WARN_PERCENT = 75;

// Cache read price as a multiple of the input rate when a price row has no
// cacheReadMult. lib/pricing.js DEFAULT_CACHE_READ_MULT.
export const DEFAULT_CACHE_READ_MULT = 0.1;
