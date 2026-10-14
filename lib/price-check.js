'use strict';

// One price check: fetch Anthropic's pricing page, parse it, compare it with the
// prices in use, and apply what is new or changed. The page carries no dates, so a
// change is dated the day after the last check that saw the old price (changeDate).
// The server runs this daily, when a model with no price of its own appears, and
// when someone clicks Check prices.

const { currentRows, clearUnmatched, BUILT_IN_DATE } = require('./pricing');
const { PRICING_URL, PriceParseError, parsePricingPage, diffPrices } = require('./price-fetch');
const { loadPriceFile, pricesSource, priceSnapshots, appendSnapshot, recordCheck } = require('./price-store');
const { localDateStr } = require('./dates');

function dayAfter(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateStr(new Date(y, m - 1, d + 1));
}

/**
 * The effective-from date for a change found now: the day after the last check,
 * else the day after the last snapshot, else the day after BUILT_IN_DATE. Never
 * later than today (a lastCheck dated in the future, from a clock set back, still
 * gives today) and never earlier than the last snapshot.
 */
function changeDate({ lastCheck, snapshots, today }) {
  const lastSnapshot = snapshots.length ? snapshots[snapshots.length - 1].effectiveFrom : null;
  let date = dayAfter(lastCheck || lastSnapshot || BUILT_IN_DATE);
  if (lastSnapshot && date < lastSnapshot) date = lastSnapshot;
  return date > today ? today : date;
}

/**
 * `fetchPage` returns the page's markdown. `now` returns a Date. `onApplied` runs
 * after a snapshot was written (the server passes clearScans, so costs are
 * computed again with the new prices).
 */
function createPriceChecker({ file, fetchPage, now = () => new Date(), onApplied = () => {} }) {
  let running = null;
  let lastAttemptAt = null;
  let lastError = null;

  function fail(kind, error) {
    lastError = error;
    return { error, kind };
  }

  async function run() {
    lastAttemptAt = now().getTime();
    let page;
    try {
      page = await fetchPage();
    } catch (err) {
      return fail('fetch', `Could not fetch ${PRICING_URL}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = parsePricingPage(page);
    } catch (err) {
      if (err instanceof PriceParseError) return fail('parse', `The pricing page did not parse, so prices are unchanged: ${err.message}`);
      return fail('internal', err.message);
    }

    // Read the file again, so the comparison and the date run against what is on disk.
    loadPriceFile(file);
    const diff = diffPrices(parsed.rows, currentRows());
    const rows = [...diff.added, ...diff.changed.map((c) => c.after)];
    const today = localDateStr(now());
    let effectiveFrom = null;
    let written;
    if (rows.length) {
      effectiveFrom = changeDate({ lastCheck: pricesSource().lastCheck, snapshots: priceSnapshots(), today });
      written = appendSnapshot({ effectiveFrom, rows, source: PRICING_URL, file, now: now(), lastCheck: today });
    } else {
      written = recordCheck({ file, date: today });
    }
    if (written.error) return fail('write', written.error);

    if (rows.length) onApplied();
    clearUnmatched();
    lastError = null;
    return { added: diff.added, changed: diff.changed, unchanged: diff.unchanged, skipped: parsed.skipped, effectiveFrom, checkedAt: now().toISOString() };
  }

  // A check that is running is shared by every caller, so two clicks, or a click
  // during the daily check, make one fetch.
  function check() {
    if (running) return running;
    running = run()
      .catch((err) => fail('internal', err.message))
      .finally(() => { running = null; });
    return running;
  }

  function state() {
    return { lastCheck: pricesSource().lastCheck, lastAttemptAt, lastError, running: running !== null };
  }

  return { check, state };
}

module.exports = { changeDate, createPriceChecker };
