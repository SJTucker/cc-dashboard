#!/usr/bin/env node
'use strict';

const express = require('express');
const os = require('os');
const path = require('path');
const { scanUsage, getProjectsDir, localDateStr } = require('./lib/scan');
const { windowStart } = require('./lib/window');
const { readRtkUsage, readRtkWindows } = require('./lib/rtk');
const { hostGuard, securityHeaders } = require('./lib/net-guard');
const { collectMarkers } = require('./lib/changes');
const { buildReport, windowRanges } = require('./lib/efficiency');
const { readLimits, readDailyShare } = require('./lib/limits');
const { readSessions, buildLiveSessions } = require('./lib/sessions');
const { readActivity } = require('./lib/activity');
const { readReviews } = require('./lib/review');
const { busiestDay, dayTotals } = require('./public/stats');
const { currentRows } = require('./lib/pricing');
const { loadPriceFile, pricesSource, appendSnapshot } = require('./lib/price-store');
const { PRICING_URL, PriceParseError, fetchPricingPage, parsePricingPage, diffPrices } = require('./lib/price-fetch');

function getArg(name) {
  const idx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = process.argv[idx];
  return arg.includes('=') ? arg.split('=').slice(1).join('=') : process.argv[idx + 1] || null;
}

// listen() validates the port synchronously and throws before the 'error'
// handler below is attached, so an unusable value has to be rejected here or the
// friendly message never prints. `--port` with no value takes the next argv
// token, which is how `--port --open` used to become NaN.
function getPort() {
  const raw = getArg('port') || process.env.PORT;
  if (raw == null) return 3600;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port ${JSON.stringify(String(raw))}. Use a whole number from 0 to 65535.`);
    process.exit(1);
  }
  return port;
}

const PORT = getPort();
const HOST = '127.0.0.1'; // intentionally not configurable - see lib/net-guard.js

const app = express();
app.use(hostGuard);
app.use(securityHeaders);
app.use(express.static(path.join(__dirname, 'public')));
// GET routes are guarded too, because each scan costs seconds of CPU. Another
// page could otherwise run scans here with <img src> tags.
app.use('/api', sameOriginOnly);

// Simple 60s cache so switching the day-range control doesn't re-scan every file on
// every click. Cleared automatically on the next scan cycle.
const CACHE_TTL_MS = 60_000;
const cache = new Map();

// scanUsage skips a session file it cannot read, which lowers that range's totals.
// The terminal gets one warning per range each time the count of skipped files
// changes, so the 5s live poll does not repeat it.
const unreadableByRange = new Map();
function warnUnreadable(range, data) {
  const n = data.meta.unreadableFiles || 0;
  if (n === (unreadableByRange.get(range) || 0)) return data;
  unreadableByRange.set(range, n);
  if (n) {
    const files = n === 1 ? '1 session file could not be read and was' : `${n} session files could not be read and were`;
    console.warn(`[scan] ${files} left out of the ${range} totals.`);
  }
  return data;
}

// Caches the scan's promise, not just its result. Refresh on the All range fires
// /api/summary?days=all and /api/changes together, both cold on the same key, and
// without this each ran its own scan of the same files (measured 4.0s vs 2.2s for
// the two combined). The promise is cached before the await so the second request
// finds it already in the map, and evicted on rejection so the next request retries
// instead of replaying the same failure until the entry expires.
async function getCached(days) {
  const key = String(days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const range = days == null ? 'all-time' : `${days}-day`;
  const promise = scanUsage({ days }).then((data) => warnUnreadable(range, data)).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { data: promise, ts: Date.now() });
  return promise;
}

// /api/summary?days=today and /api/sessions/live both need the Today scan, and
// loadAndRender requests them together. Sharing one scan for 2 seconds serves
// both from a single file walk. The 5s live poll is past that window, so each
// poll still scans afresh. A rejected scan is dropped at once so the next
// request retries.
const TODAY_SHARE_MS = 2000;
let todayScan = null; // { promise, ts }

// Before the first scan, so every cost uses the applied price history.
loadPriceFile();

// Costs are computed inside scanUsage, so a price change needs both scan caches dropped.
function clearScans() {
  cache.clear();
  todayScan = null;
}

function getTodayScan() {
  if (todayScan && Date.now() - todayScan.ts < TODAY_SHARE_MS) return todayScan.promise;
  const promise = scanUsage({ days: 'today', bucket: 'hour' }).then((data) => warnUnreadable('Today', data)).catch((err) => {
    if (todayScan && todayScan.promise === promise) todayScan = null;
    throw err;
  });
  todayScan = { promise, ts: Date.now() };
  return promise;
}

// The per-call records feed /api/changes only. Sent here they would add a few
// megabytes to every summary request, and to every 5s poll on the Today range.
function publicSummary({ efficiency, ...rest }) {
  return rest;
}

// The range picker's day counts. Each distinct count is its own cached scan of up
// to about 20 MB, and nothing evicts the cache, so only these are accepted.
const RANGE_DAYS = new Set([7, 30, 90]);
const INVALID_DAYS = (raw) => `Invalid days: ${String(raw)}. Use 7, 30, 90, 'today', or 'all'.`;

app.get('/api/summary', async (req, res) => {
  try {
    const raw = req.query.days;
    if (raw === 'today') {
      // A today-scan reads only files written since local midnight, which is fast
      // enough that caching it past getTodayScan's 2s share would only make the
      // live poll show stale numbers.
      res.json(publicSummary(await getTodayScan()));
      return;
    }
    // Only the range picker's values are accepted. Number(raw) || 30 once turned
    // days=0 and days=abc into 30 without saying so.
    let days = 30;
    if (raw === 'all') {
      days = null;
    } else if (raw != null && raw !== '') {
      const n = Number(raw);
      if (!RANGE_DAYS.has(n)) {
        res.status(400).json({ error: INVALID_DAYS(raw) });
        return;
      }
      days = n;
    }
    const data = await getCached(days);
    res.json(publicSummary(data));
  } catch (err) {
    console.error('[API] /api/summary failed:', err);
    res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
  }
});

// No cache. A full read of the reference database - 21,867 rows, both GROUP BYs,
// open and close - measured 13ms, against ~1.9s for a 30-day scanUsage(). Putting
// this behind the 60s cache above would either serve stale savings or force every
// rtk request to bust a cache that exists to protect the slow JSONL scan.
//
// The days parsing below duplicates /api/summary's rather than sharing a helper: the
// two routes disagree on what 'today' means (that one returns early past the cache,
// this one has no cache at all), and folding them together would need a flags
// argument for a nine-line branch.
app.get('/api/rtk', (req, res) => {
  try {
    const raw = req.query.days;
    if (raw === 'today') {
      res.json(readRtkUsage({ days: 'today', bucket: 'hour' }));
      return;
    }
    let days = 30;
    if (raw === 'all') {
      days = null;
    } else if (raw != null && raw !== '') {
      const n = Number(raw);
      if (!RANGE_DAYS.has(n)) {
        res.status(400).json({ error: INVALID_DAYS(raw) });
        return;
      }
      days = n;
    }
    res.json(readRtkUsage({ days }));
  } catch (err) {
    console.error('[API] /api/rtk failed:', err);
    res.status(500).json({ error: 'Failed to read rtk history', detail: err.message });
  }
});

// Plan usage changes every few minutes while Claude Code runs, and reading the
// ~70KB .claude.json takes about 1ms, so it is read on every request, uncached.
// readLimits() and readDailyShare() return null rather than throwing, so there is
// no error branch.
app.get('/api/limits', (req, res) => {
  const limits = readLimits();
  res.json(limits && { ...limits, today: readDailyShare() });
});

// All history, whatever range the page shows: a before/after needs data on both
// sides of a change. It reads the days=all cache entry, so it shares a scan with
// the "all" range. The marker files are read on every request, so an edit to
// changes.json shows on the next refresh instead of up to 60s later.
app.get('/api/changes', async (req, res) => {
  try {
    const data = await getCached(null);
    const { markers, changesFile } = collectMarkers(data.efficiency.calls);
    const rtkWindows = readRtkWindows(windowRanges(markers));
    res.json(buildReport(data.efficiency, markers, rtkWindows, changesFile));
  } catch (err) {
    console.error('[API] /api/changes failed:', err);
    res.status(500).json({ error: 'Failed to build the setup changes report', detail: err.message });
  }
});

// The Record day card's all-time value: the day with the most tokens, with its
// token total and cost. recentDays is the per-day totals for the 6 days before
// today (not today), which the Today range adds to its live totals for the
// rolling 7-day lines. It uses the days=all cache entry that /api/summary and
// /api/changes also use, so the three share one scan.
app.get('/api/records', async (req, res) => {
  try {
    const data = await getCached(null);
    const todayStr = localDateStr(new Date());
    const weekStart = localDateStr(new Date(windowStart(7)));
    const recentDays = dayTotals(data.daily).filter((d) => d.date >= weekStart && d.date < todayStr);
    res.json({ allTime: busiestDay(data.daily), recentDays });
  } catch (err) {
    console.error('[API] /api/records failed:', err);
    res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
  }
});

// Today's sessions from the snapshots in cc-dashboard/sessions/ (lib/sessions.js),
// each with its tokens, cost today and lines changed from the Today scan. Read-only:
// bin/record-statusline writes the snapshots, run by the mod in mod/ or by a
// statusline script. Each session's `activity` comes from cc-dashboard/activity/
// (lib/activity.js), written by the mod. Session ids stay on the server.
app.get('/api/sessions/live', async (req, res) => {
  try {
    const data = await getTodayScan();
    res.json(buildLiveSessions(readSessions(), data.efficiency.calls, Date.now(), data.efficiency.linesBySession, data.efficiency.titleBySession, data.efficiency.prompts, readActivity()));
  } catch (err) {
    console.error('[API] /api/sessions/live failed:', err);
    res.status(500).json({ error: 'Failed to read live sessions', detail: err.message });
  }
});

// Reviews of ended sessions from cc-dashboard/reviews/ (lib/review.js), from the
// last 7 days. Read-only: bin/review-session writes them, run by the mod in mod/.
// Each review includes its session id and transcript path, because the user pastes
// them into a prompt for another model. Only this machine can reach the API: the
// server listens on HOST (127.0.0.1). home lets the page shorten the transcript path.
app.get('/api/reviews', (req, res) => {
  try {
    res.json({ home: os.homedir(), reviews: readReviews() });
  } catch (err) {
    console.error('[API] /api/reviews failed:', err);
    res.status(500).json({ error: 'Failed to read session reviews', detail: err.message });
  }
});

// Every modern browser sends Sec-Fetch-Site. Any value other than same-origin or
// none means another page issued the request. 'none' is the user opening an /api
// URL from the address bar, which is always a GET, so a POST with 'none' is
// refused. The Host guard cannot catch a cross-site request, because a browser
// sets Host from the address it connected to, not from the page that asked.
// Non-browser clients send no such header and still work.
function sameOriginOnly(req, res, next) {
  const site = req.get('sec-fetch-site');
  const typedUrl = site === 'none' && req.method === 'GET';
  if (site && site !== 'same-origin' && !typedUrl) {
    res.status(403).json({ error: 'Cross-site requests are not accepted.' });
    return;
  }
  next();
}

app.post('/api/refresh', (req, res) => {
  clearScans();
  res.json({ ok: true });
});

// The rows the last check found new or changed. Apply saves exactly these, so what
// the panel showed is what gets saved, and the browser never sends prices.
let pendingCheck = null;

app.get('/api/prices', (req, res) => {
  res.json(pricesSource());
});

// The dashboard's only outbound request. It runs when someone clicks Check prices.
app.post('/api/prices/check', async (req, res) => {
  pendingCheck = null;
  let page;
  try {
    page = await fetchPricingPage();
  } catch (err) {
    res.status(502).json({ error: `Could not fetch ${PRICING_URL}: ${err.message}` });
    return;
  }
  try {
    const { rows, skipped } = parsePricingPage(page);
    const diff = diffPrices(rows, currentRows());
    pendingCheck = [...diff.added, ...diff.changed.map((c) => c.after)];
    res.json({ ...diff, skipped, checkedAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof PriceParseError) {
      res.status(422).json({ error: `The pricing page did not parse, so prices are unchanged: ${err.message}` });
      return;
    }
    console.error('[API] /api/prices/check failed:', err);
    res.status(500).json({ error: 'Failed to check prices', detail: err.message });
  }
});

app.post('/api/prices/apply', express.json({ limit: '1kb' }), (req, res) => {
  if (!pendingCheck || !pendingCheck.length) {
    res.status(409).json({ error: 'Nothing to apply. Check prices first.' });
    return;
  }
  const effectiveFrom = req.body ? req.body.effectiveFrom : undefined;
  const result = appendSnapshot({ effectiveFrom, rows: pendingCheck, source: PRICING_URL });
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  pendingCheck = null;
  clearScans();
  res.json(result.source);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\nClaude Code Dashboard running at http://localhost:${PORT}`);
  console.log(`Reading logs from: ${getProjectsDir()}`);
  console.log('Bound to localhost only. The one outbound request is Check prices, to platform.claude.com.\n');
  if (process.argv.includes('--open')) {
    import('open').then((mod) => mod.default(`http://localhost:${PORT}`)).catch(() => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node server.js --port 3601`);
    process.exit(1);
  }
  throw err;
});

module.exports = server;
