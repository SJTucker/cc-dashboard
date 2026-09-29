#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const { scanUsage, getProjectsDir } = require('./lib/scan');
const { readRtkUsage, readRtkWindows } = require('./lib/rtk');
const { hostGuard, securityHeaders } = require('./lib/net-guard');
const { collectMarkers } = require('./lib/changes');
const { buildReport, windowRanges } = require('./lib/efficiency');
const { readLimits } = require('./lib/limits');
const { readSessions, buildLiveSessions } = require('./lib/sessions');
const { busiestDay } = require('./public/stats');

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

// Simple 60s cache so switching the day-range control doesn't re-scan every file on
// every click. Cleared automatically on the next scan cycle.
const CACHE_TTL_MS = 60_000;
const cache = new Map();

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
  const promise = scanUsage({ days }).catch((err) => {
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

function getTodayScan() {
  if (todayScan && Date.now() - todayScan.ts < TODAY_SHARE_MS) return todayScan.promise;
  const promise = scanUsage({ days: 'today', bucket: 'hour' }).catch((err) => {
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
    // Number(raw) || 30 turned days=0 and days=abc into 30 without saying so,
    // and let a negative value through to produce a cutoff in the future.
    let days = 30;
    if (raw === 'all') {
      days = null;
    } else if (raw != null && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        res.status(400).json({ error: `Invalid days: ${String(raw)}. Use a whole number of days, 'today', or 'all'.` });
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
      if (!Number.isInteger(n) || n < 1) {
        res.status(400).json({ error: `Invalid days: ${String(raw)}. Use a whole number of days, 'today', or 'all'.` });
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
// readLimits() returns null rather than throwing, so there is no error branch.
app.get('/api/limits', (req, res) => {
  res.json(readLimits());
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

// The Record day card's all-time value. It uses the days=all cache entry that
// /api/summary and /api/changes also use, so the three share one scan.
app.get('/api/records', async (req, res) => {
  try {
    const data = await getCached(null);
    res.json({ allTime: busiestDay(data.daily) });
  } catch (err) {
    console.error('[API] /api/records failed:', err);
    res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
  }
});

// Today's sessions from the statusline snapshots (lib/sessions.js), each with its
// tokens from the Today scan. Read-only: only bin/record-statusline writes the
// snapshots. Session ids stay on the server.
app.get('/api/sessions/live', async (req, res) => {
  try {
    const data = await getTodayScan();
    res.json(buildLiveSessions(readSessions(), data.efficiency.calls));
  } catch (err) {
    console.error('[API] /api/sessions/live failed:', err);
    res.status(500).json({ error: 'Failed to read live sessions', detail: err.message });
  }
});

app.post('/api/refresh', (req, res) => {
  // Every modern browser sends Sec-Fetch-Site on a fetch, so anything other than
  // same-origin means another page issued this request. The Host guard cannot
  // catch that: a browser sets Host from the address it connected to, not from
  // the page that asked. Non-browser clients send no such header and still work.
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    res.status(403).json({ error: 'Cross-site requests are not accepted.' });
    return;
  }
  cache.clear();
  todayScan = null;
  res.json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\nMy Claude Code Dashboard running at http://localhost:${PORT}`);
  console.log(`Reading logs from: ${getProjectsDir()}`);
  console.log('Read-only. No outbound network requests. Bound to localhost only.\n');
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
