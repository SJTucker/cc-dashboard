'use strict';

// One price check: fetch Anthropic's pricing page, parse it, compare it with the
// prices in use, and apply what is new or changed. The page carries no dates, so a
// change is dated the day after the last check that saw the old price (changeDate).
// The server runs this daily, when a model with no price of its own appears, and
// when someone clicks Check prices.

const { currentRows, clearUnmatched, unmatchedModels, BUILT_IN_DATE } = require('./pricing');
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
 * gives today) and never earlier than the last snapshot. When the last snapshot is
 * dated after today, those two limits conflict and today wins; run() refuses that
 * case with kind 'clock' before it calls changeDate.
 */
function changeDate({ lastCheck, snapshots, today }) {
  const lastSnapshot = snapshots.length ? snapshots[snapshots.length - 1].effectiveFrom : null;
  let date = dayAfter(lastCheck || lastSnapshot || BUILT_IN_DATE);
  if (lastSnapshot && date < lastSnapshot) date = lastSnapshot;
  return date > today ? today : date;
}

/** The message of an Error, else the string of whatever was thrown or rejected. */
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `fetchPage` returns the page's markdown. `now` returns a Date. `onApplied` runs
 * after a snapshot was written (the server passes clearScans, so costs are
 * computed again with the new prices). A throw from it is logged and does not
 * change the result.
 *
 * check() resolves to the result of one check, or { error, kind } with kind 'fetch',
 * 'parse', 'clock', 'write', 'internal' or 'stopped'. stop() ends the checker: a
 * running check then writes nothing and calls no callback, and check() fetches
 * nothing. newUnmatched() lists the unmatched model names that no successful check
 * has looked for; the server uses it to decide whether a new name needs a check.
 */
function createPriceChecker({ file, fetchPage, now = () => new Date(), onApplied = () => {} }) {
  let running = null;
  let lastAttemptAt = null;
  let lastError = null;
  let stopped = false;
  // The unmatched names at the start of the last successful check. The page never
  // names some of them (a name keyFor cannot read), so a check cannot price them.
  let lookedFor = new Set();

  function fail(kind, error) {
    lastError = error;
    return { error, kind };
  }

  const stoppedResult = () => ({ error: 'The price checker was stopped.', kind: 'stopped' });

  // A snapshot is already written when this runs, so a throw is logged here and
  // does not turn the check into a failure.
  function notifyApplied() {
    try {
      onApplied();
    } catch (err) {
      console.error(`[prices] onApplied failed: ${errorText(err)}`);
    }
  }

  async function run() {
    if (stopped) return stoppedResult();
    lastAttemptAt = now().getTime();
    const unmatchedAtStart = new Set(unmatchedModels());
    let page;
    try {
      page = await fetchPage();
    } catch (err) {
      return stopped ? stoppedResult() : fail('fetch', `Could not fetch ${PRICING_URL}: ${errorText(err)}`);
    }
    if (stopped) return stoppedResult();
    let parsed;
    try {
      parsed = parsePricingPage(page);
    } catch (err) {
      if (err instanceof PriceParseError) return fail('parse', `The pricing page did not parse, so prices are unchanged: ${err.message}`);
      return fail('internal', errorText(err));
    }

    // Read the file again, so the comparison and the date run against what is on disk.
    loadPriceFile(file);
    const snapshots = priceSnapshots();
    const today = localDateStr(now());
    const lastDated = snapshots.length ? snapshots[snapshots.length - 1].effectiveFrom : null;
    if (lastDated && lastDated > today) {
      return fail('clock', `The last applied price change is dated ${lastDated}, after today. Check the system clock.`);
    }
    const diff = diffPrices(parsed.rows, currentRows());
    const rows = [...diff.added, ...diff.changed.map((c) => c.after)];
    let effectiveFrom = null;
    let written;
    if (rows.length) {
      effectiveFrom = changeDate({ lastCheck: pricesSource().lastCheck, snapshots, today });
      written = appendSnapshot({ effectiveFrom, rows, source: PRICING_URL, file, now: now(), lastCheck: today });
    } else {
      written = recordCheck({ file, date: today });
    }
    if (written.error) return fail('write', written.error);

    if (rows.length) notifyApplied();
    clearUnmatched();
    lookedFor = unmatchedAtStart;
    lastError = null;
    return { added: diff.added, changed: diff.changed, unchanged: diff.unchanged, skipped: parsed.skipped, effectiveFrom, checkedAt: now().toISOString() };
  }

  // A check that is running is shared by every caller, so two clicks, or a click
  // during the daily check, make one fetch.
  function check() {
    if (running) return running;
    running = run()
      .catch((err) => fail('internal', errorText(err)))
      .finally(() => { running = null; });
    return running;
  }

  function state() {
    return { lastCheck: pricesSource().lastCheck, lastAttemptAt, lastError, running: running !== null };
  }

  function stop() {
    stopped = true;
  }

  const newUnmatched = () => unmatchedModels().filter((name) => !lookedFor.has(name));

  return { check, state, stop, newUnmatched };
}

module.exports = { changeDate, createPriceChecker, errorText };
