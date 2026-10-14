#!/usr/bin/env node
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { loadConfig } = require('./lib/config-dir');
const { getProjectsDir } = require('./lib/transcript-files');
const { localDateStr, windowStart } = require('./lib/dates');
const { aggregate } = require('./lib/aggregate');
const { createRowStore } = require('./lib/rowstore');
const { getAgentUsageDir } = require('./lib/agent-steps');
const { openStore } = require('./lib/store');
const { createScanMemo } = require('./lib/scan-memo');
const { readRtkUsage, readRtkWindows, readRtkDaily } = require('./lib/rtk');
const { hostGuard, securityHeaders } = require('./lib/net-guard');
const { collectMarkers } = require('./lib/changes');
const { buildReport, windowRanges } = require('./lib/efficiency');
const { readLimits, readDailyShare, getRateLimitsPath } = require('./lib/limits');
const { readSessions, buildLiveSessions, getSessionsDir, cacheCallsOf } = require('./lib/sessions');
const { SESSION_ID_PATTERN } = require('./lib/session-id');
const { readActivity, getActivityDir } = require('./lib/activity');
const { readReviews, setDismissal, DISMISS_REASONS } = require('./lib/review');
const { createReviewDbGetter, legacyReviewsDir } = require('./lib/review-db');
const { createServerDb, getStorePath, isBusy } = require('./lib/db');
const { busiestDay, dayTotals } = require('./public/stats.mjs');
const { loadPriceFile, pricesSource, getPricesPath } = require('./lib/price-store');
const { fetchPricingPage } = require('./lib/price-fetch');
const { createPriceChecker } = require('./lib/price-check');
const { unmatchedModels } = require('./lib/pricing');

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
function getPort(configPort) {
  const raw = getArg('port') || configPort;
  if (raw == null) return 3600;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port ${JSON.stringify(String(raw))}. Use a whole number from 0 to 65535.`);
    process.exit(1);
  }
  return port;
}

const HOST = '127.0.0.1'; // intentionally not configurable - see lib/net-guard.js

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

// The per-call records feed /api/changes only. Sent here they would add a few
// megabytes to every summary request, and to every 5s poll on the Today range.
function publicSummary({ efficiency, ...rest }) {
  return rest;
}

// The range picker's day counts. Each distinct count is its own memo entry, and
// nothing evicts entries, so only these are accepted.
const RANGE_DAYS = new Set([7, 30, 90]);
const INVALID_DAYS = (raw) => `Invalid days: ${String(raw)}. Use 7, 30, 90, 'today', or 'all'.`;

// The days query of /api/summary and /api/rtk, as { days } or { error }. days is
// 'today', null (all), or one of RANGE_DAYS, and 30 when the query is absent or
// empty. Each route picks its own bucket for 'today'. Number(raw) || 30 once turned
// days=0 and days=abc into 30 without saying so, which is why anything else is an
// error.
function parseDays(raw) {
  if (raw === 'today') return { days: 'today' };
  if (raw === 'all') return { days: null };
  if (raw == null || raw === '') return { days: 30 };
  const n = Number(raw);
  return RANGE_DAYS.has(n) ? { days: n } : { error: INVALID_DAYS(raw) };
}

// bin/review-session holds the write lock while it records a review. The server
// waits SERVER_BUSY_TIMEOUT_MS (250 ms, lib/db.js) for it and then answers 503 with
// this text. The Session reviews panel shows it as text.
const DB_BUSY = 'The review database is busy. Try again.';

// Answers 503 and returns true when err is a SQLite busy error.
function sendBusy(res, err) {
  if (!isBusy(err)) return false;
  res.status(503).json({ error: DB_BUSY });
  return true;
}

// The one write the page makes to a review. app.use('/api', sameOriginOnly) in
// createServer covers both methods, so a cross-site page cannot dismiss or undo, the same
// protection the price check route has.
const DISMISS_PATH = '/api/reviews/:sessionId/suggestions/:idx/dismiss';
const QUOTED_REASONS = DISMISS_REASONS.map((r) => `"${r}"`);
const REASON_ERROR = `reason must be ${QUOTED_REASONS.slice(0, -1).join(', ')} or ${QUOTED_REASONS.at(-1)}.`;

// The session id and idx from the path, or null after answering 400.
function suggestionTarget(req, res) {
  const { sessionId, idx } = req.params;
  if (!SESSION_ID_PATTERN.test(sessionId) || !/^\d+$/.test(idx) || !Number.isSafeInteger(Number(idx))) {
    res.status(400).json({ error: 'Expected a session id and a whole-number suggestion index.' });
    return null;
  }
  return { sessionId, idx: Number(idx) };
}

// CC_DASHBOARD_PRICE_CHECK=off stops the daily and new-model price checks. Anything
// else, or no value, leaves them on. Read once, in the program block below: the
// tests build their config with loadConfig and must not start background fetches.
function priceCheckOn(env) {
  return String(env.CC_DASHBOARD_PRICE_CHECK || '').trim().toLowerCase() !== 'off';
}

// Builds the dashboard for one config (lib/config-dir.js) and returns an
// http.Server that is not listening yet. Everything that keeps state lives in
// here: the transcripts.db handle, the row store, the reviews import flag, the
// aggregate memo and the price checker. The handle closes when the server
// closes. The price table is the exception: lib/pricing.js holds it for the whole
// process, so the last prices.json loaded or applied sets it for every server in
// the process.
function createServer(config) {
  const projectsDir = getProjectsDir(config.configDir);
  const storePath = getStorePath(config.configDir);
  const pricesPath = getPricesPath(config.configDir);
  const rateLimitsPath = getRateLimitsPath(config.configDir);

  // One transcripts.db handle for the row store and the reviews (lib/db.js).
  const serverDb = createServerDb(storePath);
  const getReviewDb = createReviewDbGetter(serverDb.get, legacyReviewsDir(config.configDir));
  let rowStore = null;
  // Opened by warmUp when the server starts listening, which reports a
  // transcripts.db that cannot be opened through console.warn. A request that
  // arrives first opens it itself.
  function getRowStore() {
    if (!rowStore) rowStore = createRowStore({ projectsDir: () => projectsDir, agentUsageDir: () => getAgentUsageDir(config.configDir), store: openStore(storePath, serverDb.get), log: (line) => console.log(line) });
    return rowStore;
  }

  // Before the first scan, so every cost uses the applied price history.
  loadPriceFile(pricesPath);
  const { scan, clear: clearScans } = createScanMemo({ getRowStore, aggregate, getProjectsDir: () => projectsDir });
  // One price check at a time (lib/price-check.js). Check prices, the daily check and
  // the new-model check all go through it. After a snapshot is written, the cached
  // scans are dropped so the next request computes costs with the new prices.
  const priceChecker = createPriceChecker({ file: pricesPath, fetchPage: fetchPricingPage, onApplied: clearScans });

  // Background price checks, on when config.priceCheck is set. A check starts at
  // startup and on an hourly tick while the last successful check is before today,
  // and after /api/summary answers when a model with no price of its own was seen
  // and no check was attempted in the last hour. A failed check logs one line, and
  // the next tick tries again. The timer is unref'd so it never keeps the process
  // alive, and cleared when the server closes.
  const HOUR_MS = 60 * 60 * 1000;
  // A lastCheck after today (the clock was set back) is due too, so the check does not wait for the clock to catch up.
  const checkDue = () => (priceChecker.state().lastCheck || '') !== localDateStr(new Date());
  const attemptedLastHour = () => {
    const at = priceChecker.state().lastAttemptAt;
    return at != null && Date.now() - at < HOUR_MS;
  };
  function checkInBackground() {
    if (priceChecker.state().running) return;
    priceChecker.check().then((result) => {
      if (result.error) console.warn(`[prices] check failed: ${result.error}`);
      else if (result.added.length || result.changed.length) {
        console.log(`[prices] applied ${result.added.length} new and ${result.changed.length} changed prices from ${result.effectiveFrom}`);
      }
    });
  }
  let priceTimer = null;
  if (config.priceCheck) {
    if (checkDue()) checkInBackground();
    priceTimer = setInterval(() => { if (checkDue()) checkInBackground(); }, HOUR_MS);
    priceTimer.unref();
  }

  const app = express();
  // Express names itself in every response unless told not to.
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(securityHeaders);
  app.use(express.static(path.join(__dirname, 'public')));
  // GET routes are guarded too, because each scan costs seconds of CPU. Another
  // page could otherwise run scans here with <img src> tags.
  app.use('/api', sameOriginOnly);

  app.get('/api/summary', async (req, res) => {
    const { days, error } = parseDays(req.query.days);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    try {
      const data = days === 'today' ? await scan('today', 'hour') : await scan(days);
      res.json(publicSummary(data));
      if (config.priceCheck && unmatchedModels().length && !attemptedLastHour()) checkInBackground();
    } catch (err) {
      console.error('[API] /api/summary failed:', err);
      res.status(500).json({ error: 'Failed to scan Claude Code logs', detail: err.message });
    }
  });

  // No cache. A full read of the reference database - 36,552 rows, every query, open
  // and close - measured 118ms, against ~1.9s for a 30-day read of every transcript.
  // Putting this behind the aggregate memo above would either serve stale savings or
  // force every rtk request to clear a memo that exists to avoid re-aggregating the
  // transcripts.
  app.get('/api/rtk', (req, res) => {
    const { days, error } = parseDays(req.query.days);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    try {
      res.json(days === 'today' ? readRtkUsage({ days, bucket: 'hour', dbPath: config.rtkDb }) : readRtkUsage({ days, dbPath: config.rtkDb }));
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
    const limits = readLimits({ claudeJson: config.claudeJsonPath, rateLimits: rateLimitsPath });
    res.json(limits && { ...limits, today: readDailyShare({ rateLimits: rateLimitsPath }) });
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
      const { markers, changesFile } = collectMarkers(data.efficiency.calls, config);
      const rtkWindows = readRtkWindows(windowRanges(markers), config.rtkDb);
      const report = buildReport(data.efficiency, markers, rtkWindows, changesFile);
      // The two rtk rows' daily series come from rtk's own history, not the scan.
      const rtkDaily = readRtkDaily(config.rtkDb);
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
  // bin/record-statusline writes the snapshots, run by the mod in mod/. Each
  // session's `activity` comes from cc-dashboard/activity/ (lib/activity.js), written
  // by the mod. Session ids stay on the server.
  app.get('/api/sessions/live', async (req, res) => {
    try {
      const data = await scan('today', 'hour');
      const { efficiency } = data;
      // A waiting session's cache TTL depends on its newest cache write, which can
      // be before midnight. The row store holds the whole transcript, so the Today
      // scan's calls are not used for it (as bin/cache-state does).
      // The index maps each file name to its row-store entries and is built on the
      // first waiting session, so a poll with none never copies and sorts the
      // entries. Only the requested session's calls are concatenated.
      let entriesByFile = null;
      const transcriptCalls = (sessionId) => {
        if (!entriesByFile) {
          entriesByFile = new Map();
          for (const e of getRowStore().entries()) {
            const name = path.basename(e.path);
            if (!entriesByFile.has(name)) entriesByFile.set(name, []);
            entriesByFile.get(name).push(e);
          }
        }
        return cacheCallsOf((entriesByFile.get(`${sessionId}.jsonl`) || []).flatMap((e) => e.rows.calls || []));
      };
      res.json(buildLiveSessions(readSessions(getSessionsDir(config.configDir)), efficiency.calls, Date.now(), efficiency.linesBySession, efficiency.titleBySession, efficiency.prompts, readActivity(getActivityDir(config.configDir)), {
        branchesBySession: efficiency.branchesBySession,
        branchBySession: efficiency.branchBySession,
        firstPromptBySession: efficiency.firstPromptBySession,
        cacheCallsOf: transcriptCalls,
      }));
    } catch (err) {
      console.error('[API] /api/sessions/live failed:', err);
      res.status(500).json({ error: 'Failed to read live sessions', detail: err.message });
    }
  });

  // Reviews of ended sessions from the reviews and suggestions tables in
  // transcripts.db (lib/review.js), finished in the last 7 days. bin/review-session
  // writes the reviews, run by the mod in mod/. The dismiss routes below write the
  // dismissals. Each review includes its session id and transcript path, because the
  // user pastes them into a prompt for another model. Only this machine can reach the
  // API: the server listens on HOST (127.0.0.1). When transcripts.db cannot be
  // opened the answer is a 500 with the reason. When the one-time import
  // (getReviewDb) or a write meets the lock of bin/review-session the answer is a
  // 503 with DB_BUSY. The panel shows either as text.
  app.get('/api/reviews', (req, res) => {
    try {
      res.json({ reviews: readReviews(getReviewDb(), projectsDir) });
    } catch (err) {
      if (sendBusy(res, err)) return;
      console.error('[API] /api/reviews failed:', err);
      res.status(500).json({ error: 'Failed to read session reviews', detail: err.message });
    }
  });

  // Sets or clears the dismissal and answers. reason null clears it.
  function changeDismissal(res, target, reason) {
    try {
      const dismissedAt = reason ? Date.now() : null;
      if (!setDismissal(getReviewDb(), target.sessionId, target.idx, reason, dismissedAt ?? undefined)) {
        res.status(404).json({ error: 'No such suggestion.' });
        return;
      }
      res.json({ ok: true, sessionId: target.sessionId, idx: target.idx, dismissedAt, reason });
    } catch (err) {
      if (sendBusy(res, err)) return;
      console.error('[API] dismiss failed:', err);
      res.status(500).json({ error: 'Failed to save the dismissal', detail: err.message });
    }
  }

  app.post(DISMISS_PATH, express.json({ limit: '1kb' }), (req, res) => {
    const target = suggestionTarget(req, res);
    if (!target) return;
    const reason = req.body ? req.body.reason : undefined;
    if (!DISMISS_REASONS.includes(reason)) {
      res.status(400).json({ error: REASON_ERROR });
      return;
    }
    changeDismissal(res, target, reason);
  });

  app.delete(DISMISS_PATH, (req, res) => {
    const target = suggestionTarget(req, res);
    if (target) changeDismissal(res, target, null);
  });

  app.post('/api/refresh', (req, res) => {
    clearScans();
    res.json({ ok: true });
  });

  app.get('/api/prices', (req, res) => {
    res.json({ ...pricesSource(), lastError: priceChecker.state().lastError });
  });

  // Fetches the pricing page and applies every new or changed price at once. It is
  // the same check the server runs daily and when a model with no price of its own
  // shows up; this route runs it when someone clicks Check prices. A failed check
  // changes no price: 502 when the page could not be fetched, 422 when it did not
  // parse, 500 for anything else.
  const CHECK_STATUS = { fetch: 502, parse: 422 };
  app.post('/api/prices/check', async (req, res) => {
    const result = await priceChecker.check();
    if (result.error) {
      if (!CHECK_STATUS[result.kind]) console.error('[API] /api/prices/check failed:', result.error);
      res.status(CHECK_STATUS[result.kind] || 500).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // Express 4 answers a body-parser error (malformed JSON, body over the limit)
  // with an HTML page. The routes under /api send JSON, so this answers the same
  // way. Routes that send their own error JSON never reach it. Static files keep
  // Express's default handler.
  app.use('/api', (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    // Express's default handler printed err.stack. A 4xx is the client's error, so only 5xx is logged.
    if (status >= 500) console.error(`[server] ${req.method} ${req.baseUrl}${req.path} failed:`, err);
    res.status(status).json({ error: err.message });
  });

  const server = http.createServer(app);
  server.on('close', () => {
    clearInterval(priceTimer);
    serverDb.close();
  });
  // Starts the first read of the transcripts without a request. The listen callback
  // calls it, so the stat pass and the synchronous store.loadAll run before the
  // browser's first request arrives instead of while that request waits. Nothing
  // awaits the result: the requests that need the rows wait for them themselves, and a
  // failed read is reported again by each of those requests.
  server.warmUp = () => {
    try {
      getRowStore().refresh().catch((err) => console.warn(`[rows] The first read failed: ${err.message}`));
    } catch (err) {
      console.warn(`[rows] The first read could not start: ${err.message}`);
    }
  };
  return server;
}

// Started as a program (npm start, node server.js): read the environment once,
// check the port, listen, and close cleanly on Ctrl-C (SIGINT) or a service stop
// (SIGTERM). Required as a module (the tests), nothing starts.
if (require.main === module) {
  const config = { ...loadConfig(), priceCheck: priceCheckOn(process.env) };
  const port = getPort(config.port);
  const server = createServer(config);

  server.listen(port, HOST, () => {
    console.log(`\nClaude Code Dashboard running at http://localhost:${port}`);
    console.log(`Reading logs from: ${getProjectsDir(config.configDir)}`);
    console.log(config.priceCheck
      ? 'Bound to localhost only. The one outbound request is the pricing page, from platform.claude.com, once a day, when a model has no price, and on Check prices.\n'
      : 'Bound to localhost only. The one outbound request is Check prices, to platform.claude.com. The daily and new-model price checks are off.\n');
    server.warmUp();
    if (process.argv.includes('--open')) {
      import('open').then((mod) => mod.default(`http://localhost:${port}`)).catch(() => {});
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: node server.js --port 3601`);
      process.exit(1);
    }
    throw err;
  });

  // close() waits for open connections, and a browser tab holds a keep-alive one,
  // so they are closed too. The server's close event closes the transcripts.db
  // handle, which checkpoints the WAL into transcripts.db and removes
  // transcripts.db-wal, and then the process exits.
  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { createServer, priceCheckOn };
