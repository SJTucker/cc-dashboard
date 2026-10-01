'use strict';

// The first instant a range covers, as epoch ms. 'today' starts at local midnight.
// A number of days N covers today and the N - 1 days before it, each from local
// midnight, so every day except today is complete. null (all time) has no start.
// setDate moves by calendar days, so a daylight saving change inside the range
// cannot move the start off midnight the way subtracting N * 24h would.
function windowStart(days, now = Date.now()) {
  if (days == null) return null;
  const d = new Date(now);
  if (days !== 'today') d.setDate(d.getDate() - (days - 1));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = { windowStart };
