'use strict';

// The mod settings: <cfg>/cc-dashboard/settings.json. Keys:
//   handoff         'document' | 'image' | 'off', the cache-expiry handoff
//   transcriptIndex the transcript index written after each turn
//   reviews         the Haiku call behind session reviews
//   setupMarkers    the setup check at session start
//   setupLabels     the Haiku calls behind setup-change labels and release judging
//   activity        the activity files written by track()
//   limitBand       the plan limit band above the prompt
// The server, a bin/ script and the mod read this file. Only a literal false turns
// a two-valued key off. A saved handoff 'transcript', the old name of 'image', reads
// as 'image', and any other value outside the three allowed ones reads as 'document'.
// A missing, unreadable or malformed file gives every default. The mod
// keeps its own copy of this parse in mod/hooks/setup.ts (parseDashboardSettings).

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./files');

const bool = Object.freeze({ kind: 'boolean', default: true });
const SETTING_SPECS = Object.freeze({
  handoff: Object.freeze({ kind: 'choice', values: Object.freeze(['document', 'image', 'off']), default: 'document', aliases: Object.freeze({ transcript: 'image' }) }),
  transcriptIndex: bool,
  reviews: bool,
  setupMarkers: bool,
  setupLabels: bool,
  activity: bool,
  limitBand: bool,
});

const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(Object.entries(SETTING_SPECS).map(([key, spec]) => [key, spec.default])),
);

function getSettingsPath(configDir) {
  return path.join(configDir, 'cc-dashboard', 'settings.json');
}

function readObject(configDir) {
  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(configDir), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** True when value is allowed for key. */
function validSettingValue(key, value) {
  const spec = Object.hasOwn(SETTING_SPECS, key) ? SETTING_SPECS[key] : null;
  if (!spec) return false;
  return spec.kind === 'boolean' ? typeof value === 'boolean' : spec.values.includes(value);
}

/** Never throws. */
function readSettings(configDir) {
  const data = readObject(configDir);
  const out = {};
  for (const [key, spec] of Object.entries(SETTING_SPECS)) {
    if (spec.kind === 'boolean') out[key] = data[key] !== false;
    else {
      const value = spec.aliases && Object.hasOwn(spec.aliases, data[key]) ? spec.aliases[data[key]] : data[key];
      out[key] = spec.values.includes(value) ? value : spec.default;
    }
  }
  return out;
}

/** Merges the known keys of settings into the file and keeps any other key. Writes
 * through a temp file and a rename. Throws on failure. */
function writeSettings(configDir, settings) {
  const file = getSettingsPath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const merged = readObject(configDir);
  for (const key of Object.keys(SETTING_SPECS)) {
    if (validSettingValue(key, settings[key])) merged[key] = settings[key];
  }
  writeFileAtomic(file, JSON.stringify(merged, null, 2) + '\n');
}

module.exports = { SETTING_SPECS, DEFAULT_SETTINGS, getSettingsPath, readSettings, validSettingValue, writeSettings };
