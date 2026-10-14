'use strict';

// The applied price history: ~/.claude/cc-dashboard/prices.json. Each snapshot is
// one price check that found a new or changed price (lib/price-check.js), dated by
// the day its change is taken to have started. `lastCheck` is the day of the last
// check that read the pricing page successfully. lib/pricing.js turns the
// snapshots into dated price versions.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./files');
const { setSnapshots, validateRow, BUILT_IN_DATE } = require('./pricing');
const { localDateStr } = require('./dates');

function getPricesPath(configDir) {
  return path.join(configDir, 'cc-dashboard', 'prices.json');
}

function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function checkRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'has no rows';
  for (const row of rows) {
    const reason = validateRow(row);
    if (reason) return reason;
  }
  return null;
}

// A reason string, or null when the parsed file is usable.
function validateFile(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.snapshots)) return 'not a version 1 prices file';
  if (data.lastCheck != null && !isRealDate(data.lastCheck)) return 'lastCheck is not a YYYY-MM-DD date';
  let previous = '';
  for (const [i, snap] of data.snapshots.entries()) {
    if (!isRealDate(snap.effectiveFrom)) return `snapshot ${i + 1} has no valid effectiveFrom date`;
    if (snap.effectiveFrom < previous) return `snapshot ${i + 1} is dated before the one above it`;
    previous = snap.effectiveFrom;
    const reason = checkRows(snap.rows);
    if (reason) return `snapshot ${i + 1}: ${reason}`;
  }
  return null;
}

let state = { snapshots: [], error: null, lastCheck: null };

/**
 * Read the prices file and install its snapshots over the built-in table. A missing
 * file means built-in prices. A file that fails validation is ignored as a whole,
 * because half a history would price some days from one table and some from
 * another with no reason the dashboard could show.
 */
function loadPriceFile(file) {
  let snapshots = [];
  let lastCheck = null;
  let error = null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    error = validateFile(data);
    if (!error) {
      snapshots = data.snapshots;
      lastCheck = data.lastCheck || null;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') error = err instanceof SyntaxError ? 'not valid JSON' : err.message;
  }
  if (error) console.warn(`[prices] ignoring ${file}: ${error}`);
  state = { snapshots, error, lastCheck };
  setSnapshots(snapshots);
  return pricesSource();
}

/** Where the prices in use came from, for the line under the Cost by model table. */
function pricesSource() {
  const last = state.snapshots[state.snapshots.length - 1];
  return {
    kind: last ? 'fetched' : 'built-in',
    date: last ? last.effectiveFrom : BUILT_IN_DATE,
    appliedAt: last ? last.appliedAt : null,
    snapshots: state.snapshots.length,
    error: state.error,
    lastCheck: state.lastCheck,
  };
}

/** The snapshots of the last load, in effectiveFrom order. */
function priceSnapshots() {
  return [...state.snapshots];
}

// Write then rename, so a crash mid-write cannot leave half a history on disk.
// Returns an error message, or null.
function writeData(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    return `Could not write ${file}: ${err.message}`;
  }
  return null;
}

/**
 * Append one snapshot and reload. `lastCheck` is written with it; when it is not
 * given, the file's existing lastCheck is kept. Returns { source } or { error }.
 */
function appendSnapshot({ effectiveFrom, rows, source, file, now = new Date(), lastCheck }) {
  // Re-read the file so a hand edit, a check from another process, or damage
  // that happened after the last load is what these checks and the write run against.
  loadPriceFile(file);
  if (state.error) return { error: `The prices file is unreadable (${state.error}). Fix or remove ${file} first.` };
  if (!isRealDate(effectiveFrom)) return { error: 'The effective date must be a YYYY-MM-DD date.' };
  if (effectiveFrom > localDateStr(now)) return { error: 'The effective date cannot be in the future.' };
  if (lastCheck != null && !isRealDate(lastCheck)) return { error: 'lastCheck must be a YYYY-MM-DD date.' };
  const last = state.snapshots[state.snapshots.length - 1];
  if (last && effectiveFrom < last.effectiveFrom) {
    return { error: `The effective date cannot be before the last applied change (${last.effectiveFrom}).` };
  }
  const reason = checkRows(rows);
  if (reason) return { error: `Refused a row: ${reason}` };

  const kept = lastCheck != null ? lastCheck : state.lastCheck;
  const data = {
    version: 1,
    ...(kept ? { lastCheck: kept } : {}),
    snapshots: [...state.snapshots, { effectiveFrom, appliedAt: now.toISOString(), source, rows }],
  };
  const failure = writeData(file, data);
  return failure ? { error: failure } : { source: loadPriceFile(file) };
}

/**
 * Record that the pricing page was read on `date` and held nothing new. Re-reads
 * the file first and refuses to write over an unreadable one, as appendSnapshot
 * does. Every snapshot is kept. Returns { source } or { error }.
 */
function recordCheck({ file, date }) {
  loadPriceFile(file);
  if (state.error) return { error: `The prices file is unreadable (${state.error}). Fix or remove ${file} first.` };
  if (!isRealDate(date)) return { error: 'The check date must be a YYYY-MM-DD date.' };
  const failure = writeData(file, { version: 1, lastCheck: date, snapshots: state.snapshots });
  return failure ? { error: failure } : { source: loadPriceFile(file) };
}

module.exports = { getPricesPath, loadPriceFile, pricesSource, priceSnapshots, appendSnapshot, recordCheck };
