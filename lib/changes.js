'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProjectsDir } = require('./scan');

// Markers for the setup changes panels, from three read-only sources. Plugins and
// models leave exact timestamps on disk. Everything else - CLAUDE.md edits, hooks,
// rtk config - only the user knows, so it comes from a hand-edited changes.json.

const KINDS = new Set(['plugin', 'skill', 'hook', 'claude-md', 'rtk', 'config', 'effort', 'model', 'other']);
const DAY_MS = 24 * 60 * 60 * 1000;

function getChangesPath() {
  if (process.env.CHANGES_FILE) return process.env.CHANGES_FILE.replace(/^~/, os.homedir());
  return path.join(__dirname, '..', 'changes.json');
}

// installed_plugins.json sits beside projects/ under the Claude config dir, so it
// follows CLAUDE_CONFIG_DIR the same way the scan does. It keeps only the latest
// lastUpdated per plugin, so installedAt is the one time it reliably records.
function pluginMarkers() {
  const file = path.join(path.dirname(getProjectsDir()), 'plugins', 'installed_plugins.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return []; // no plugins installed, or a file mid-write: no markers from here
  }
  const markers = [];
  for (const [name, installs] of Object.entries(parsed?.plugins || {})) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const t = Date.parse(install?.installedAt);
      if (Number.isNaN(t)) continue;
      markers.push({ t, kind: 'plugin', label: `${name.split('@')[0]} plugin installed`, source: 'plugin' });
    }
  }
  return markers;
}

// A model already in use when the history begins would only mark the start of the
// log, so a model first seen within a day of the earliest call gets no marker.
function modelMarkers(calls) {
  let earliest = Infinity;
  const first = new Map();
  for (const c of calls) {
    if (c.t < earliest) earliest = c.t;
    if (!c.model) continue;
    const seen = first.get(c.model);
    if (seen == null || c.t < seen) first.set(c.model, c.t);
  }
  return [...first]
    .filter(([, t]) => t - earliest >= DAY_MS)
    .map(([model, t]) => ({ t, kind: 'model', label: `${model} first used`, source: 'model' }));
}

// Date.parse reads '2026-09-04T11:15' as local time but a bare '2026-09-04' as UTC
// midnight, which west of UTC is the previous evening. Appending a time makes both
// forms local.
function parseLocal(date) {
  if (typeof date !== 'string') return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00` : date);
}

function fileMarkers() {
  const filePath = getChangesPath();
  const fail = (error) => ({ markers: [], file: { path: filePath, status: 'error', error } });
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { markers: [], file: { path: filePath, status: 'missing' } };
    return fail(err.message);
  }
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    return fail(`Not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(entries)) return fail('Expected a JSON array of { "date", "kind", "label" } entries.');

  const markers = [];
  const skipped = [];
  entries.forEach((entry, i) => {
    const t = parseLocal(entry?.date);
    if (Number.isNaN(t)) {
      skipped.push(i + 1);
      return;
    }
    markers.push({
      t,
      kind: KINDS.has(entry.kind) ? entry.kind : 'other',
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label : '(no label)',
      source: 'file',
    });
  });
  const file = skipped.length
    ? { path: filePath, status: 'error', error: `Skipped entry ${skipped.join(', ')}: "date" is missing or not a date.` }
    : { path: filePath, status: 'ok' };
  return { markers, file };
}

function collectMarkers(calls) {
  const { markers, file } = fileMarkers();
  return {
    markers: [...pluginMarkers(), ...modelMarkers(calls), ...markers].sort((a, b) => a.t - b.t),
    changesFile: file,
  };
}

module.exports = { getChangesPath, pluginMarkers, modelMarkers, fileMarkers, collectMarkers };
