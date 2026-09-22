#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const { scanUsage, getProjectsDir } = require('./lib/scan');
const { hostGuard, securityHeaders } = require('./lib/net-guard');

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

async function getCached(days) {
  const key = String(days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const data = await scanUsage({ days });
  cache.set(key, { data, ts: Date.now() });
  return data;
}

app.get('/api/summary', async (req, res) => {
  try {
    const raw = req.query.days;
    if (raw === 'today') {
      // A today-scan reads only files written since local midnight, which is fast
      // enough that caching it would only make the live poll show stale numbers.
      res.json(await scanUsage({ days: 'today', bucket: 'hour' }));
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
    res.json(data);
  } catch (err) {
    console.error('[API] /api/summary failed:', err);
    res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
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
