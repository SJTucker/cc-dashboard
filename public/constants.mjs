// Numbers the page shares with the server. Each comment names the server
// constant it equals; test/front-end-constants.test.js fails when they differ.

// Rows drawn per tool list and per rtk command list. lib/rtk.js DETAIL_LIMIT
// caps the rtk detail rows the server sends at the same number.
export const DETAIL_LIMIT = 12;

// A session counts as live while its last call is this recent.
// lib/sessions.js LIVE_WINDOW_MS.
export const LIVE_WINDOW_MS = 10 * 60 * 1000;

// Days of session reviews /api/reviews returns. lib/review.js KEEP_MS.
export const REVIEW_DAYS = 7;

// The limits banner shows once a plan window reaches this percent. The server
// has no matching constant.
export const LIMIT_WARN_PERCENT = 75;
