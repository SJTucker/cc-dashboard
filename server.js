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
const { getHeadlessUsageDir } = require('./lib/headless-usage');
const { openStore } = require('./lib/store');
const { createScanMemo } = require('./lib/scan-memo');
const { readRtkUsage, readRtkWindows, readRtkDaily } = require('./lib/rtk');
const { hostGuard, securityHeaders } = require('./lib/net-guard');
const { collectMarkers } = require('./lib/changes');
const { buildReport, windowRanges } = require('./lib/efficiency');
const { readLimits, readUsageFetchedAt, readDailyShare, getRateLimitsPath } = require('./lib/limits');
const { readSessions, buildLiveSessions, getSessionsDir, cacheCallsOf } = require('./lib/sessions');
const { readCacheState, getCacheDir } = require('./lib/cache');
const { SESSION_ID_PATTERN } = require('./lib/session-id');
const { createOrchestrations } = require('./lib/orchestrations/discover');
const { appendPost } = require('./lib/orchestrations/board');
const { writeSteerRequest } = require('./lib/orchestrations/controls');
const { readActivity, getActivityDir } = require('./lib/activity');
const { SETTING_SPECS, readSettings, writeSettings, validSettingValue } = require('./lib/settings');
const { reviewBacklog, skipBacklog } = require('./lib/review');
const { readReviews, readClosedPage, parseCursor, suggestionReason, setDismissal, DISMISS_REASONS, CLOSED_PAGE_SIZE, CLOSED_PAGE_MAX } = require('./lib/review');
const { createReviewDbGetter, legacyReviewsDir } = require('./lib/review-db');
const { createServerDb, getStorePath, isBusy } = require('./lib/db');
const { busiestDay, dayTotals } = require('./public/stats.mjs');
const { buildHighscores, todayRecords } = require('./lib/highscores');
const { loadPriceFile, pricesSource, getPricesPath } = require('./lib/price-store');
const { fetchPricingPage } = require('./lib/price-fetch');
const { createPriceChecker } = require('./lib/price-check');
const { createUsageRefresher, getUsageRefreshDir } = require('./lib/usage-refresh');

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

// The days query of the reviews routes, as { days } or { error }. days is 'today',
// 7, 30 or 90, or null for All. The panel is on the Analysis tab only and always
// sends its range, so a missing value is an error. lib/review.js starts 'today' at
// local midnight.
function parseReviewDays(raw) {
  if (raw === 'today') return { days: 'today' };
  if (raw === 'all') return { days: null };
  if (raw === '7' || raw === '30' || raw === '90') return { days: Number(raw) };
  return { error: `Invalid days: ${String(raw)}. Use 'today', 7, 30, 90 or 'all'.` };
}

// The limit query of /api/reviews/closed: CLOSED_PAGE_SIZE when missing, else a whole
// number from 1, capped at CLOSED_PAGE_MAX. null for anything else.
function parseLimit(raw) {
  if (raw == null) return CLOSED_PAGE_SIZE;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw) || Number(raw) < 1) return null;
  return Math.min(Number(raw), CLOSED_PAGE_MAX);
}

const EXPIRED_UNDO = 'An expired suggestion cannot be reopened. Mark it done, duplicate or not useful instead.';

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

// CC_DASHBOARD_USAGE_REFRESH=off stops the headless /usage runs (lib/usage-refresh.js).
// CC_DASHBOARD_CLAUDE_BIN names the claude binary, and `claude` on PATH is the default.
// Read once, in the program block below, for the same reason as priceCheckOn.
function usageRefreshFrom(env) {
  if (String(env.CC_DASHBOARD_USAGE_REFRESH || '').trim().toLowerCase() === 'off') return null;
  return { bin: String(env.CC_DASHBOARD_CLAUDE_BIN || '').trim() || 'claude' };
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
    if (!rowStore) rowStore = createRowStore({ projectsDir: () => projectsDir, agentUsageDir: () => getAgentUsageDir(config.configDir), headlessUsageDir: () => getHeadlessUsageDir(config.configDir), store: openStore(storePath, serverDb.get), log: (line) => console.log(line) });
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
  // that no successful check has looked for (priceChecker.newUnmatched) and no check
  // was attempted in the last hour. A failed check logs one line, and the next tick
  // tries again. The timer is unref'd so it never keeps the process alive. When the
  // server closes, the timer is cleared and the checker is stopped.
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
      if (result.kind === 'stopped') return;
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

  // Headless /usage runs that keep the usage cache fresh while a page is open, on
  // when config.usageRefresh is set. GET /api/limits and POST /api/refresh start them.
  // Tests pass their own spawn.
  const usageRefresher = config.usageRefresh
    ? createUsageRefresher({
      bin: config.usageRefresh.bin,
      spawn: config.usageRefresh.spawn,
      cwd: getUsageRefreshDir(config.configDir),
      lastFetchedAt: () => readUsageFetchedAt(config.claudeJsonPath),
    })
    : null;

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
      // publicSummary strips efficiency, so the record values are taken first.
      const summary = publicSummary(data);
      if (days === 'today') summary.todayRecords = todayRecords(data, localDateStr(new Date()));
      res.json(summary);
      if (config.priceCheck && priceChecker.newUnmatched().length && !attemptedLastHour()) checkInBackground();
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
    usageRefresher?.seen();
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
      const saved = readSettings(config.configDir);
      res.json({ ...report, labelsOn: saved.setupLabels, markersOn: saved.setupMarkers });
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

  // The High scores boards: the top 10 of nine records from the all-time aggregate,
  // without today's entries (the browser merges today in from the Today summary's
  // todayRecords). The payload is memoised per all-time scan object and date: scan()
  // returns the same object until the row store changes, and the date decides which
  // entries count as today.
  const boardsMemo = new WeakMap();
  app.get('/api/highscores', async (req, res) => {
    try {
      const todayStr = localDateStr(new Date());
      const data = await scan(null);
      let memo = boardsMemo.get(data);
      if (!memo || memo.day !== todayStr) {
        memo = { day: todayStr, payload: buildHighscores(data, todayStr) };
        boardsMemo.set(data, memo);
      }
      res.json(memo.payload);
    } catch (err) {
      console.error('[API] /api/highscores failed:', err);
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
      // The index maps each file name to its row-store entries. It is built on the
      // first lookup, so a poll with no waiting session and no session to measure
      // never copies and sorts the entries. A lookup reads only the requested
      // session's entries.
      let entriesByFile = null;
      const entriesOf = (sessionId) => {
        if (!entriesByFile) {
          entriesByFile = new Map();
          for (const e of getRowStore().entries()) {
            const name = path.basename(e.path);
            if (!entriesByFile.has(name)) entriesByFile.set(name, []);
            entriesByFile.get(name).push(e);
          }
        }
        return entriesByFile.get(`${sessionId}.jsonl`) || [];
      };
      const transcriptCalls = (sessionId) => cacheCallsOf(entriesOf(sessionId).flatMap((e) => e.rows.calls || []));
      // The time of the session's first typed prompt over the whole transcript, or
      // null. Unlike efficiency.prompts, it is not limited to today.
      const firstPromptAt = (sessionId) => {
        let first = null;
        for (const e of entriesOf(sessionId)) {
          for (const p of e.rows.prompts || []) {
            if (p.sessionId === sessionId && (first === null || p.t < first)) first = p.t;
          }
        }
        return first;
      };
      const activityOff = !readSettings(config.configDir).activity;
      const live = buildLiveSessions(readSessions(getSessionsDir(config.configDir)), efficiency.calls, Date.now(), efficiency.linesBySession, efficiency.titleBySession, efficiency.prompts, activityOff ? new Map() : readActivity(getActivityDir(config.configDir)), {
        branchesBySession: efficiency.branchesBySession,
        branchBySession: efficiency.branchBySession,
        firstPromptBySession: efficiency.firstPromptBySession,
        handoffTitleBySession: efficiency.handoffTitleBySession,
        recapBySession: efficiency.recapBySession,
        cacheCallsOf: transcriptCalls,
        cacheStateOf: (sessionId) => readCacheState(getCacheDir(config.configDir), sessionId),
        firstPromptAtOf: firstPromptAt,
      });
      if (activityOff) {
        for (const row of live.sessions) delete row.activity;
        live.activityOff = true;
      }
      res.json(live);
    } catch (err) {
      console.error('[API] /api/sessions/live failed:', err);
      res.status(500).json({ error: 'Failed to read live sessions', detail: err.message });
    }
  });

  // Reviews of ended sessions from the reviews and suggestions tables in
  // transcripts.db (lib/review.js), finished in the range picker's range. bin/review-session
  // writes the reviews, run by the mod in mod/. The dismiss routes below write the
  // dismissals. Each review includes its session id and transcript path, because the
  // user pastes them into a prompt for another model. Only this machine can reach the
  // API: the server listens on HOST (127.0.0.1). When transcripts.db cannot be
  // opened the answer is a 500 with the reason. When the one-time import
  // (getReviewDb) or a write meets the lock of bin/review-session the answer is a
  // 503 with DB_BUSY. The panel shows either as text.
  app.get('/api/reviews', (req, res) => {
    const range = parseReviewDays(req.query.days);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }
    try {
      res.json({ ...readReviews(getReviewDb(), projectsDir, { days: range.days }), enabled: readSettings(config.configDir).reviews });
    } catch (err) {
      if (sendBusy(res, err)) return;
      console.error('[API] /api/reviews failed:', err);
      res.status(500).json({ error: 'Failed to read session reviews', detail: err.message });
    }
  });

  // One page of reviews with closed suggestions in the range, newest first, from
  // lib/review.js readClosedPage. before is the next value of the previous page.
  app.get('/api/reviews/closed', (req, res) => {
    const range = parseReviewDays(req.query.days);
    const limit = parseLimit(req.query.limit);
    const before = req.query.before == null ? null : parseCursor(req.query.before);
    const error = range.error
      || (limit == null && `Invalid limit: ${String(req.query.limit)}. Use a whole number from 1.`)
      || (req.query.before != null && !before && 'Invalid before: use the next value of an earlier page.');
    if (error) {
      res.status(400).json({ error });
      return;
    }
    try {
      res.json(readClosedPage(getReviewDb(), projectsDir, { days: range.days, before, limit }));
    } catch (err) {
      if (sendBusy(res, err)) return;
      console.error('[API] /api/reviews/closed failed:', err);
      res.status(500).json({ error: 'Failed to read closed suggestions', detail: err.message });
    }
  });

  // Sets or clears the dismissal and answers. reason null clears it.
  function changeDismissal(res, target, reason) {
    try {
      const db = getReviewDb();
      if (reason === null && suggestionReason(db, target.sessionId, target.idx) === 'expired') {
        res.status(400).json({ error: EXPIRED_UNDO });
        return;
      }
      const dismissedAt = reason ? Date.now() : null;
      if (!setDismissal(db, target.sessionId, target.idx, reason, dismissedAt ?? undefined)) {
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

  app.get('/api/settings', (req, res) => {
    res.json(readSettings(config.configDir));
  });

  // Saves the mod settings. A key the body leaves out keeps its saved value.
  // Turning reviews from off to on first finds the sessions that ended while it was
  // off. Without `backlog` they answer 409 with the count and nothing is written, so
  // the page can ask. 'skip' records them as skipped before the switch is written,
  // because the mod can only claim sessions once reviews are on. 'review' leaves them
  // unclaimed for the mod to pick up.
  const SETTING_KEYS = Object.keys(SETTING_SPECS);
  app.post('/api/settings', express.json({ limit: '1kb' }), async (req, res) => {
    const body = req.body;
    const bad = !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((k) => k !== 'backlog' && !SETTING_KEYS.includes(k))
      || SETTING_KEYS.some((k) => k in body && !validSettingValue(k, body[k]))
      || ('backlog' in body && body.backlog !== 'review' && body.backlog !== 'skip')
      || !SETTING_KEYS.some((k) => k in body);
    if (bad) {
      res.status(400).json({ error: `Send any of ${SETTING_KEYS.join(', ')} with a valid value, and backlog as "review" or "skip".` });
      return;
    }
    try {
      const saved = readSettings(config.configDir);
      const turnsReviewsOn = body.reviews === true && !saved.reviews;
      if (turnsReviewsOn) {
        const db = getReviewDb();
        const sessions = await reviewBacklog({ db, sessionsDir: getSessionsDir(config.configDir), projects: projectsDir, now: Date.now() });
        if (sessions.length && !body.backlog) {
          res.status(409).json({ error: 'backlog', backlog: sessions.length });
          return;
        }
        if (body.backlog === 'skip') skipBacklog(db, sessions, Date.now());
      }
      // Read again: a POST that arrived during the await above may have changed the other key.
      const latest = readSettings(config.configDir);
      const next = Object.fromEntries(SETTING_KEYS.map((k) => [k, k in body ? body[k] : latest[k]]));
      writeSettings(config.configDir, next);
      res.json(next);
    } catch (err) {
      if (sendBusy(res, err)) return;
      console.error('[API] /api/settings failed:', err);
      res.status(500).json({ error: 'Failed to save the settings', detail: err.message });
    }
  });

  app.delete(DISMISS_PATH, (req, res) => {
    const target = suggestionTarget(req, res);
    if (target) changeDismissal(res, target, null);
  });

  app.post('/api/refresh', (req, res) => {
    clearScans();
    usageRefresher?.refreshNow();
    res.json({ ok: true });
  });

  app.get('/api/prices', (req, res) => {
    res.json({ ...pricesSource(), lastError: priceChecker.state().lastError });
  });

  // Fetches the pricing page and applies every new or changed price at once. It is
  // the same check the server runs daily and when a model with no price of its own
  // shows up; this route runs it when someone clicks Check prices. A failed check
  // changes no price: 502 when the page could not be fetched, 422 when it did not
  // parse, 409 when the last applied change is dated after today (the clock was set
  // back), 500 for anything else.
  const CHECK_STATUS = { fetch: 502, parse: 422, clock: 409 };
  app.post('/api/prices/check', async (req, res) => {
    const result = await priceChecker.check();
    if (result.error) {
      if (!CHECK_STATUS[result.kind]) console.error('[API] /api/prices/check failed:', result.error);
      res.status(CHECK_STATUS[result.kind] || 500).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // The Orchestration tab. The browser polls the list and, for the selected
  // orchestration, its detail. Without the orchestrate skill installed the list
  // answers at once without reading any session.
  const orchestrations = createOrchestrations(config.configDir);
  app.get('/api/orchestrations', (req, res) => {
    try {
      if (!orchestrations.installed()) {
        res.json({ installed: false, orchestrations: [] });
        return;
      }
      res.json({ installed: true, orchestrations: orchestrations.list() });
    } catch (err) {
      console.error('[API] /api/orchestrations failed:', err);
      res.status(500).json({ error: 'Failed to read orchestrations', detail: err.message });
    }
  });
  app.get('/api/orchestrations/:id', (req, res) => {
    if (!SESSION_ID_PATTERN.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid orchestration id' });
      return;
    }
    try {
      const detail = orchestrations.detail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: 'Unknown orchestration' });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error('[API] /api/orchestrations/:id failed:', err);
      res.status(500).json({ error: 'Failed to read the orchestration', detail: err.message });
    }
  });

  // The owner's board post, from "You", appended to the orchestration's board file.
  // The board path comes from the orchestration, never from the request.
  // Text over max is refused, not cut, as the steer route does. appendPost still cuts for bin/board-post.
  const cleanText = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
  app.post('/api/orchestrations/:id/board', express.json({ limit: '8kb' }), (req, res) => {
    const body = req.body;
    const title = cleanText(body?.title, 120);
    const text = body?.body === undefined ? '' : typeof body.body === 'string' && body.body.trim().length <= 2000 ? body.body.trim() : null;
    if (!SESSION_ID_PATTERN.test(req.params.id) || title === null || text === null) {
      res.status(400).json({ error: 'Send a title of 1 to 120 characters, and optionally a body of up to 2000, as text.' });
      return;
    }
    try {
      const target = orchestrations.boardPathOf(req.params.id);
      if (!target) {
        res.status(404).json({ error: 'Unknown orchestration' });
        return;
      }
      if (!target.boardPath || !path.isAbsolute(target.boardPath) || !target.boardPath.endsWith('.board.jsonl')) {
        res.status(409).json({ error: 'no board yet' });
        return;
      }
      res.status(201).json(appendPost(target.boardPath, { from: 'You', title, body: text }));
    } catch (err) {
      console.error('[API] /api/orchestrations/:id/board failed:', err);
      res.status(500).json({ error: 'Failed to post to the board', detail: err.message });
    }
  });

  // A steer for one worker: a request file in the folder of the orchestrator's live
  // session, which the mod in that session delivers.
  app.post('/api/orchestrations/:id/steer', express.json({ limit: '8kb' }), (req, res) => {
    const agentId = req.body?.agentId;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!SESSION_ID_PATTERN.test(req.params.id) || typeof agentId !== 'string' || !/^[a-z0-9]{1,64}$/.test(agentId) || !text || text.length > 2000) {
      res.status(400).json({ error: 'Send an agentId and text of 1 to 2000 characters.' });
      return;
    }
    try {
      const target = orchestrations.controlsOf(req.params.id);
      const worker = target?.workers.get(agentId);
      if (!worker) {
        res.status(404).json({ error: target ? 'Unknown worker' : 'Unknown orchestration' });
        return;
      }
      if (!worker.canSteer) {
        res.status(409).json({ error: 'worker finished' });
        return;
      }
      if (!target.liveSessionId) {
        res.status(409).json({ error: 'orchestrator not live' });
        return;
      }
      const request = writeSteerRequest(config.configDir, target.liveSessionId, { agentId, task: worker.task, text });
      res.status(202).json({ id: request.id });
    } catch (err) {
      console.error('[API] /api/orchestrations/:id/steer failed:', err);
      res.status(500).json({ error: 'Failed to queue the steer', detail: err.message });
    }
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
    priceChecker.stop();
    usageRefresher?.stop();
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
  const config = { ...loadConfig(), priceCheck: priceCheckOn(process.env), usageRefresh: usageRefreshFrom(process.env) };
  const port = getPort(config.port);
  const server = createServer(config);

  server.listen(port, HOST, () => {
    console.log(`\nClaude Code Dashboard running at http://localhost:${port}`);
    console.log(`Reading logs from: ${getProjectsDir(config.configDir)}`);
    console.log(config.priceCheck
      ? 'Bound to localhost only. The one outbound request is the pricing page, from platform.claude.com, once a day, when a model has no price, and on Check prices.\n'
      : 'Bound to localhost only. The one outbound request is Check prices, to platform.claude.com. The daily and new-model price checks are off.\n');
    console.log(config.usageRefresh
      ? `While a page is open, Plan usage runs \`${config.usageRefresh.bin} -p /usage\` every 5 minutes. Claude Code makes that request with its own login.\n`
      : 'The Plan usage refresh is off.\n');
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

module.exports = { createServer, priceCheckOn, usageRefreshFrom };
