'use strict';

// The applied price history: ~/.claude/cc-dashboard/prices.json. Each snapshot is
// one Apply from the Cost by model panel, dated by the effective-from day chosen
// there. lib/pricing.js turns the snapshots into dated price versions.

const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('./config-dir');
const { writeFileAtomic } = require('./files');
const { setSnapshots, validateRow, BUILT_IN_DATE } = require('./pricing');
const { localDateStr } = require('./dates');

function getPricesPath() {
  return path.join(getConfigDir(), 'cc-dashboard', 'prices.json');
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

let state = { snapshots: [], error: null };

/**
 * Read the prices file and install its snapshots over the built-in table. A missing
 * file means built-in prices. A file that fails validation is ignored as a whole,
 * because half a history would price some days from one table and some from
 * another with no reason the dashboard could show.
 */
function loadPriceFile() {
  const file = getPricesPath();
  let snapshots = [];
  let error = null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    error = validateFile(data);
    if (!error) snapshots = data.snapshots;
  } catch (err) {
    if (err.code !== 'ENOENT') error = err instanceof SyntaxError ? 'not valid JSON' : err.message;
  }
  if (error) console.warn(`[prices] ignoring ${file}: ${error}`);
  state = { snapshots, error };
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
  };
}

/** Append one snapshot and reload. Returns { source } or { error }. */
function appendSnapshot({ effectiveFrom, rows, source, now = new Date() }) {
  // Re-read the file so a hand edit, an Apply from another process, or damage
  // that happened after the last load is what these checks and the write run against.
  loadPriceFile();
  if (state.error) return { error: `The prices file is unreadable (${state.error}). Fix or remove ${getPricesPath()} first.` };
  if (!isRealDate(effectiveFrom)) return { error: 'The effective date must be a YYYY-MM-DD date.' };
  if (effectiveFrom > localDateStr(now)) return { error: 'The effective date cannot be in the future.' };
  const last = state.snapshots[state.snapshots.length - 1];
  if (last && effectiveFrom < last.effectiveFrom) {
    return { error: `The effective date cannot be before the last applied change (${last.effectiveFrom}).` };
  }
  const reason = checkRows(rows);
  if (reason) return { error: `Refused a row: ${reason}` };

  const file = getPricesPath();
  const data = { version: 1, snapshots: [...state.snapshots, { effectiveFrom, appliedAt: now.toISOString(), source, rows }] };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write then rename, so a crash mid-write cannot leave half a history on disk.
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    return { error: `Could not write ${file}: ${err.message}` };
  }
  return { source: loadPriceFile() };
}

module.exports = { getPricesPath, loadPriceFile, pricesSource, appendSnapshot };
