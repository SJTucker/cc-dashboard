'use strict';

// The Record day card's all-time value, cached in ~/.claude/cc-dashboard/records.json
// so /api/records does not run the all-history scan (2 to 4 s cold) on every page
// load. Past days' totals never change, so the cached record goes stale in two
// ways only. Today overtakes it, and /api/summary?days=today writes today here.
// Or prices change, and price apply deletes the file. The 3-day expiry covers
// anything else, such as deleted transcripts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeAtomic } = require('./sessions');

const RECORD_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function expandHome(p) {
  return p.replace(/^~/, os.homedir());
}

// Same precedence as getPricesPath in lib/price-store.js.
function getRecordsPath() {
  if (process.env.RECORDS_FILE) return expandHome(process.env.RECORDS_FILE);
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), 'cc-dashboard', 'records.json');
  return path.join(os.homedir(), '.claude', 'cc-dashboard', 'records.json');
}

// The cached record, or null when the file is missing, unreadable, not a record,
// or 3 days old or older.
function readRecord(now = Date.now()) {
  try {
    const { allTime, computedAt } = JSON.parse(fs.readFileSync(getRecordsPath(), 'utf8'));
    if (!allTime || typeof allTime.tokens !== 'number' || typeof allTime.date !== 'string' || typeof allTime.cost !== 'number' || typeof computedAt !== 'number') return null;
    return now - computedAt < RECORD_TTL_MS ? allTime : null;
  } catch {
    return null;
  }
}

// A failed write is logged and dropped. The cache only saves time, so a read-only
// disk must not break /api/records.
function writeRecord(allTime, now = Date.now()) {
  const file = getRecordsPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // writeAtomic below fails too, and logs it.
  }
  if (!writeAtomic(file, JSON.stringify({ allTime, computedAt: now }))) {
    console.warn(`[records] Could not write ${file}`);
  }
}

function clearRecord() {
  try {
    fs.unlinkSync(getRecordsPath());
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[records] Could not delete ${getRecordsPath()}: ${err.message}`);
  }
}

module.exports = { RECORD_TTL_MS, getRecordsPath, readRecord, writeRecord, clearRecord };
