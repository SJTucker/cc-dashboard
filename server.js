#!/usr/bin/env node
'use strict';

const express = require('express');
const os = require('os');
const path = require('path');
const { getProjectsDir, localDateStr } = require('./lib/scan');
const { aggregate } = require('./lib/aggregate');
const { getRowStore } = require('./lib/rowstore');
const { windowStart } = require('./lib/window');
const { readRtkUsage, readRtkWindows, readRtkDaily } = require('./lib/rtk');
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

// The row store skips a session file it cannot read, which lowers that range's totals.
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

// Before the first scan, so every cost uses the applied price history.
loadPriceFile();

// The latest aggregate for each range, reused while the row store's generation and
// the local date are unchanged. A range's result is about 22 MB, so only the latest
// one per range is kept. The date is part of the check because a range's start moves
// at midnight with no transcript changing.
const memo = new Map(); // `${days}:${bucket}` -> { generation, day, data }

// Every route that needs a range goes through here. The row store re-reads only the
// transcripts that changed, so a call with nothing new costs one stat pass.
// Concurrent calls share that pass.
async function scan(days, bucket = 'day') {
  const rowStore = getRowStore();
  await rowStore.refresh();
  const key = `${days}:${bucket}`;
  const day = localDateStr(new Date());
  const hit = memo.get(key);
  if (hit && hit.generation === rowStore.generation && hit.day === day) return hit.data;
  const range = days == null ? 'all-time' : days === 'today' ? 'Today' : `${days}-day`;
  const data = warnUnreadable(
    range,
    aggregate(rowStore.entries().map((e) => e.rows), { days, bucket, projectsDir: getProjectsDir() }),
  );
  memo.set(key, { generation: rowStore.generation, day, data });
  return data;
}

// Costs are computed when rows are aggregated, so a price change drops the memo. The
// stored rows hold token counts only and need no re-read.
function clearScans() {
  memo.clear();
}

// The per-call records feed /api/changes only. Sent here they would add a few
// megabytes to every summary request, and to every 5s poll on the Today range.
function publicSummary({ efficiency, ...rest }) {
  return rest;
}

// The range picker's day counts. Each distinct count is its own memo entry of up
// to about 22 MB, and nothing evicts entries, so only these are accepted.
const RANGE_DAYS = new Set([7, 30, 90]);
const INVALID_DAYS = (raw) => `Invalid days: ${String(raw)}. Use 7, 30, 90, 'today', or 'all'.`;

app.get('/api/summary', async (req, res) => {
  try {
    const raw = req.query.days;
    if (raw === 'today') {
      const data = await scan('today', 'hour');
      res.json(publicSummary(data));
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
    const data = await scan(days);
    res.json(publicSummary(data));
  } catch (err) {
    console.error('[API] /api/summary failed:', err);
    res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
  }
});

// No cache. A full read of the reference database - 21,867 rows, both GROUP BYs,
// open and close - measured 13ms, against ~1.9s for a 30-day scanUsage(). Putting
// this behind the aggregate memo above would either serve stale savings or force every
// rtk request to clear a memo that exists to avoid re-aggregating the transcripts.
//
// The days parsing below duplicates /api/summary's rather than sharing a helper: the
// two routes disagree on what 'today' means (that one reads the row store and memo,
// this one reads the rtk database with no cache at all), and folding them together would need a flags
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
// sides of a change. It reads the all-time aggregate, the same one
// the "all" range uses. The marker files are read on every request, so an edit to
// changes.json shows on the next refresh instead of up to 60s later. `daily` holds
// one series per before/after row; the two rtk series are added here because they
// come from rtk's database, not the scan.
app.get('/api/changes', async (req, res) => {
  try {
    const data = await scan(null);
    const { markers, changesFile } = collectMarkers(data.efficiency.calls);
    const rtkWindows = readRtkWindows(windowRanges(markers));
    const report = buildReport(data.efficiency, markers, rtkWindows, changesFile);
    // The two rtk rows' daily series come from rtk's own history, not the scan.
    const rtkDaily = readRtkDaily();
    if (rtkDaily) Object.assign(report.daily, rtkDaily);
    res.json(report);
  } catch (err) {
    console.error('[API] /api/changes failed:', err);
    res.status(500).json({ error: 'Failed to build the setup changes report', detail: err.message });
  }
});

// The Record day card's all-time value: the day with the most tokens, with its
// token total and cost, from the all-time aggregate. recentDays is the per-day totals
// for the 6 days before today (not today), which the Today range adds to its live
// totals for the rolling 7-day lines. It reads the 7-day aggregate, the one the 7d
// range also uses.
app.get('/api/records', async (req, res) => {
  try {
    const todayStr = localDateStr(new Date());
    const weekStart = localDateStr(new Date(windowStart(7)));
    const [all, week] = await Promise.all([scan(null), scan(7)]);
    const allTime = busiestDay(all.daily);
    const recentDays = dayTotals(week.daily).filter((d) => d.date >= weekStart && d.date < todayStr);
    res.json({ allTime, recentDays });
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
    const data = await scan('today', 'hour');
    const { efficiency } = data;
    res.json(buildLiveSessions(readSessions(), efficiency.calls, Date.now(), efficiency.linesBySession, efficiency.titleBySession, efficiency.prompts, readActivity(), {
      branchesBySession: efficiency.branchesBySession,
      branchBySession: efficiency.branchBySession,
      firstPromptBySession: efficiency.firstPromptBySession,
    }));
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
