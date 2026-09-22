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

const PORT = Number(getArg('port') || process.env.PORT || 3600);
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
    const days = raw === 'all' ? null : Number(raw) || 30;
    const data = await getCached(days);
    res.json(data);
  } catch (err) {
    console.error('[API] /api/summary failed:', err);
    res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
  }
});

app.post('/api/refresh', (_req, res) => {
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
