'use strict';

// Local-time date helpers shared by the aggregate step, the rtk reader, the setup
// changes and the live sessions. Every key is built from the local calendar, so a
// chart's buckets match the user's day.

// The first instant a range covers, as epoch ms. 'today' starts at local midnight.
// A number of days N covers today and the N - 1 days before it, each from local
// midnight, so every day except today is complete. null (all time) has no start.
// setDate moves by calendar days, so a daylight saving change inside the range
// cannot move the start off midnight the way subtracting N * 24h would.
// Any other days value throws: 0 would start tomorrow and a string would give NaN.
function windowStart(days, now = Date.now()) {
  if (days == null) return null;
  if (days !== 'today' && !(Number.isInteger(days) && days >= 1)) {
    throw new TypeError(`windowStart: days must be 'today', null or a whole number from 1, got ${String(days)}`);
  }
  const d = new Date(now);
  if (days !== 'today') d.setDate(d.getDate() - (days - 1));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 'YYYY-MM-DD' for the local day of d.
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 'YYYY-MM-DDTHH' for the local hour of d.
function localHourStr(d) {
  return `${localDateStr(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

// The hour keys of the local day that starts at `midnight` (epoch ms), in order.
// It calls setHours(h) for h from 0 to 23. On the spring-forward day 02:00 does not
// exist, setHours(2) lands on 03:00, and the duplicate key is dropped, so that day
// has 23 keys. That is the day's real shape, so it is not padded back to 24. On the
// fall-back day the repeated hour has one key, so that day has 24.
function hourSlots(midnight) {
  const keys = new Set();
  for (let h = 0; h < 24; h++) {
    const slot = new Date(midnight);
    slot.setHours(h);
    keys.add(localHourStr(slot));
  }
  return [...keys];
}

module.exports = { windowStart, localDateStr, localHourStr, hourSlots };
