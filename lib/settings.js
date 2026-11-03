'use strict';

// The dashboard switches: ~/.claude/cc-dashboard/settings.json. `reviews` allows
// the Haiku call behind session reviews and `setupLabels` allows the Haiku call
// behind setup-change labels. The server, a bin/ script and the mod all read this
// file. Only a literal false turns a switch off, so a missing, unreadable or
// malformed file leaves both on.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./files');

const DEFAULT_SETTINGS = Object.freeze({ reviews: true, setupLabels: true });

function getSettingsPath(configDir) {
  return path.join(configDir, 'cc-dashboard', 'settings.json');
}

/** Never throws. */
function readSettings(configDir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(getSettingsPath(configDir), 'utf8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...DEFAULT_SETTINGS };
  return { reviews: data.reviews !== false, setupLabels: data.setupLabels !== false };
}

/** Writes through a temp file and a rename. Throws on failure. */
function writeSettings(configDir, settings) {
  const file = getSettingsPath(configDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ reviews: settings.reviews, setupLabels: settings.setupLabels }, null, 2) + '\n');
}

module.exports = { DEFAULT_SETTINGS, getSettingsPath, readSettings, writeSettings };
