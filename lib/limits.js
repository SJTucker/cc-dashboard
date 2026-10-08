'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { localDateStr } = require('./scan');

// Plan usage for the Today range: the two windows that Claude Code's /usage screen
// and statusline show. There are two sources, read as of "now" and merged by
// picking whichever is newer:
//
// - Claude Code caches its last /usage fetch in .claude.json under
//   cachedUsageUtilization. That cache is undocumented, so every read here is
//   defensive: a shape this code does not expect means no panel, never an error.
//   The file also holds account details, and only the fields below leave this
//   module.
// - bin/record-limits reads the rate_limits object Claude Code's statusLine
//   command receives on stdin and writes it to a small rate-limits.json (see
//   recordRateLimits below). Its numbers change after every API response in any
//   running session, which is far more often than a manual /usage.
//
// Both sources are normalized into the same shape before merging.

const WINDOWS = [
  ['five_hour', 'Current session'],
  ['seven_day', 'Current week (all models)'],
];

function expandHome(p) {
  return p.replace(/^~/, os.homedir());
}

// With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside that
// directory. Otherwise the file sits in the home directory, beside ~/.claude/.
function getClaudeJsonPath() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), '.claude.json');
  return path.join(os.homedir(), '.claude.json');
}

// Where recordRateLimits writes, and readLimits reads, the statusline-derived
// rate limits. Mirrors getClaudeJsonPath's precedence, but the file lives
// directly under CLAUDE_CONFIG_DIR rather than being named after it.
function getRateLimitsPath() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), 'rate-limits.json');
  return path.join(os.homedir(), '.claude', 'rate-limits.json');
}

function parseReset(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Reads Claude Code's own /usage cache from .claude.json.
function readUsageCache(file, now) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // no file (an API-key login, a fresh install) or one caught mid-write
  }
  const cache = parsed?.cachedUsageUtilization;
  if (typeof cache?.fetchedAtMs !== 'number') return null;
  const limits = [];
  for (const [key, label] of WINDOWS) {
    const w = cache.utilization?.[key];
    if (typeof w?.utilization !== 'number') continue;
    const resetsAt = parseReset(w.resets_at);
    // Past its reset time the cached percent describes a window that has ended.
    // Claude Code drops such a window from the statusline for the same reason.
    if (resetsAt != null && resetsAt <= now) continue;
    limits.push({ key, label, percent: w.utilization, resetsAt });
  }
  return limits.length ? { fetchedAt: cache.fetchedAtMs, limits } : null;
}

// Reads the rate-limits.json that recordRateLimits writes.
function readStatuslineLimits(file, now) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // no file yet, or one caught mid-write
  }
  if (typeof parsed?.fetchedAtMs !== 'number') return null;
  const rateLimits = parsed.rate_limits;
  if (typeof rateLimits !== 'object' || rateLimits === null) return null;
  const limits = [];
  for (const [key, label] of WINDOWS) {
    const w = rateLimits[key];
    if (typeof w?.used_percentage !== 'number') continue;
    const resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : null;
    // Same past-reset filter as the usage cache, above.
    if (resetsAt != null && resetsAt <= now) continue;
    limits.push({ key, label, percent: w.used_percentage, resetsAt });
  }
  return limits.length ? { fetchedAt: parsed.fetchedAtMs, limits } : null;
}

// Where today's share of the weekly limit starts: the weekly percent at the start
// of the reading's local day. A day starts at the last reading before it, so the
// day's first API response counts toward the day. It starts at 0 when the weekly
// window reset since the previous reading, because the usage before a reset
// belongs to the old week. When the previous reading is from earlier the same day
// and no baseline for the day exists, the true start of the day is unknown. The day
// then counts from that previous reading and is marked 'first-reading'. That case
// happens on the first write after upgrading to a version that keeps dayStart. With
// no earlier reading at all, the day starts at its first reading. Only the previous
// reading decides the baseline, because Claude Code drops a window whose reset has
// passed, so the reading after a reset can have no weekly window. Returns undefined
// when neither the previous reading nor this one has a weekly window and no
// baseline for the day exists yet.
function dayStartFor(existing, input, fetchedAtMs) {
  const date = localDateStr(new Date(fetchedAtMs));
  const previous = existing?.rate_limits?.seven_day;
  const hasPrevious = typeof existing?.fetchedAtMs === 'number' && typeof previous?.used_percentage === 'number';
  if (hasPrevious && typeof previous.resets_at === 'number' && previous.resets_at * 1000 <= fetchedAtMs) {
    return { date, percent: 0, from: 'reset' };
  }
  if (existing?.dayStart?.date === date) return existing.dayStart;
  if (hasPrevious) {
    const sameDay = localDateStr(new Date(existing.fetchedAtMs)) === date;
    return { date, percent: previous.used_percentage, from: sameDay ? 'first-reading' : 'previous-reading' };
  }
  const week = input.rate_limits.seven_day;
  if (typeof week?.used_percentage !== 'number') return undefined;
  return { date, percent: week.used_percentage, from: 'first-reading' };
}

// input is the parsed JSON a Claude Code statusLine command receives on stdin.
// Writes rate-limits.json only when input carries a usable rate_limits object
// and a readable transcript, and only when that transcript is newer than
// whatever is already on disk. Several sessions render their statuslines
// concurrently, so this stamp — the transcript's mtime, which is when the
// session last got an API response — is what keeps an idle session from
// overwriting a busier session's newer numbers. It also keeps `dayStart`, the
// weekly percent at the start of the local day (see `dayStartFor`).
function recordRateLimits(input, file = getRateLimitsPath()) {
  if (typeof input?.rate_limits !== 'object' || input.rate_limits === null) return;
  let stat;
  try {
    stat = fs.statSync(input.transcript_path);
  } catch {
    return;
  }
  const fetchedAtMs = stat.mtime.getTime();

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = null;
  }
  if (typeof existing?.fetchedAtMs === 'number' && existing.fetchedAtMs > fetchedAtMs) return;

  const tmp = `${file}.${process.pid}`;
  try {
    const dayStart = dayStartFor(existing, input, fetchedAtMs);
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAtMs, rate_limits: input.rate_limits, dayStart }));
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
  }
}

// Merges the two sources, keeping whichever was fetched more recently. Either
// or both may be absent (no file, malformed, no window inside its reset time).
function readLimits({ claudeJson = getClaudeJsonPath(), rateLimits = getRateLimitsPath(), now = Date.now() } = {}) {
  const usageCache = readUsageCache(claudeJson, now);
  const statusline = readStatuslineLimits(rateLimits, now);
  if (!statusline) return usageCache ? { ...usageCache, source: 'usage-cache' } : null;
  if (!usageCache) return { ...statusline, source: 'statusline' };
  return statusline.fetchedAt > usageCache.fetchedAt
    ? { ...statusline, source: 'statusline' }
    : { ...usageCache, source: 'usage-cache' };
}

// The owner works five days a week, so each workday gets a fifth of the weekly limit.
const DAILY_BUDGET_PERCENT = 20;
const WORKDAYS = [1, 2, 3, 4, 5]; // Date#getDay: Monday to Friday

// Workdays from today until the weekly reset. A day counts when the window is still
// open at noon that day, so a reset at 05:00 does not count the day it falls on.
// The loop stops after 14 days, because a weekly window never resets later than that.
function workdaysLeft(now, resetsAt) {
  const day = new Date(now);
  day.setHours(12, 0, 0, 0);
  let count = 0;
  for (let i = 0; i < 14 && day.getTime() < resetsAt; i += 1) {
    if (WORKDAYS.includes(day.getDay())) count += 1;
    day.setDate(day.getDate() + 1);
  }
  return count;
}

/**
 * Today's share of the weekly limit, from rate-limits.json: the weekly percent now
 * minus the weekly percent when today started. The fixed budget is
 * DAILY_BUDGET_PERCENT on a workday. The rolling budget spreads the weekly percent
 * left at the start of today over the workdays left before the reset. Weekends have
 * neither. Returns null when the file is missing or has no weekly window.
 */
function readDailyShare({ rateLimits = getRateLimitsPath(), now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rateLimits, 'utf8'));
  } catch {
    return null;
  }
  const week = parsed?.rate_limits?.seven_day;
  if (typeof parsed?.fetchedAtMs !== 'number' || typeof week?.used_percentage !== 'number') return null;

  const date = localDateStr(new Date(now));
  let resetsAt = typeof week.resets_at === 'number' ? week.resets_at * 1000 : null;
  let weekPercent = week.used_percentage;
  let dayStartPercent;
  let from;
  if (resetsAt != null && resetsAt <= now) {
    // The window ended and no newer reading has arrived: the new week is at 0.
    weekPercent = 0;
    dayStartPercent = 0;
    from = 'reset';
    resetsAt = null;
  } else if (parsed.dayStart?.date === date && typeof parsed.dayStart.percent === 'number') {
    dayStartPercent = parsed.dayStart.percent;
    from = parsed.dayStart.from;
  } else {
    // No API response yet today, so today starts where the latest reading left off.
    dayStartPercent = weekPercent;
    from = 'no-reading-today';
  }

  const workday = WORKDAYS.includes(new Date(now).getDay());
  const left = workday && resetsAt != null ? workdaysLeft(now, resetsAt) : null;
  return {
    date,
    weekPercent,
    dayStartPercent,
    share: Math.max(0, weekPercent - dayStartPercent),
    from,
    workday,
    budget: workday ? DAILY_BUDGET_PERCENT : null,
    rollingBudget: left ? (100 - dayStartPercent) / left : null,
    workdaysLeft: left,
    resetsAt,
  };
}

module.exports = {
  getClaudeJsonPath, getRateLimitsPath, recordRateLimits, readLimits, readDailyShare,
  DAILY_BUDGET_PERCENT, WORKDAYS,
};
