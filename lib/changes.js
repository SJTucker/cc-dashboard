'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProjectsDir } = require('./scan');
const { readVerdicts, compareVersions } = require('./updates');

const RELEASE = /^\d+\.\d+\.\d+$/;

// Markers for the setup changes panels, from five read-only sources. Plugins and
// models leave exact timestamps on disk. Setup changes the mod found at session start
// (CLAUDE.md, rules, settings, skills, agents, hook scripts, rtk config) come from
// cc-dashboard/changes/*.json. Claude Code releases come from updates.json, which
// bin/judge-updates writes. Any other change comes from a hand-edited changes.json.

const KINDS = new Set(['plugin', 'skill', 'hook', 'claude-md', 'rtk', 'config', 'effort', 'model', 'claude-code', 'other']);
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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
      markers.push({ t, kind: 'plugin', label: pluginLabel(name, install), source: 'plugin' });
    }
  }
  return markers;
}

// installed_plugins.json has one entry per install scope, so a plugin installed at
// both project and user scope - typescript-lsp here, project scope for my-project and
// then user scope two minutes later - produces two installs with the same name and
// would otherwise render as two identical markers. Naming the scope and project on
// anything but a user-scope install tells them apart.
function pluginLabel(name, install) {
  const base = `${name.split('@')[0]} plugin installed`;
  if (!install || install.scope === 'user' || !install.scope) return base;
  const project = typeof install.projectPath === 'string' ? install.projectPath.split('/').filter(Boolean).pop() : null;
  return project ? `${base} (${install.scope} ${project})` : `${base} (${install.scope})`;
}

// The earliest call overall, and the first call per value of `key` (a model, a
// version). Calls without that key count toward the earliest call only.
function firstCalls(calls, key) {
  let earliest = Infinity;
  const first = new Map();
  for (const c of calls) {
    if (c.t < earliest) earliest = c.t;
    const value = c[key];
    if (!value) continue;
    const seen = first.get(value);
    if (seen == null || c.t < seen) first.set(value, c.t);
  }
  return { earliest, first };
}

// Claude Code deletes transcripts after cleanupPeriodDays (30 by default), so
// history has a sliding start rather than a fixed one. A model already in use when
// that history begins would only mark the earliest surviving transcript, not an
// actual switch, and the before-window a marker needs for comparison is WEEK_MS
// long, so a model with less than a full week of history before its first call
// cannot be compared and gets no marker.
function modelMarkers(calls) {
  const { earliest, first } = firstCalls(calls, 'model');
  return [...first]
    .filter(([, t]) => t - earliest >= WEEK_MS)
    .map(([model, t]) => ({ t, kind: 'model', label: `${model} first used`, source: 'model' }));
}

// A Claude Code release Haiku judged relevant (bin/judge-updates), marked at the
// first call made on it. The changelog has no dates, so the transcripts supply the
// time. The week-of-history rule is modelMarkers' rule, and it also drops the
// version already running when history starts, which is not an update.
// The desktop app and the CLI can run different builds. A release first used after
// a higher release is an older build opened late, so it gets no marker. The walk
// goes through first calls in time order and tracks the highest plain release seen,
// counting every release whether or not it is relevant or inside the first week.
// Non-release versions such as dev builds get no marker and do not count.
function updateMarkers(calls) {
  const verdicts = readVerdicts();
  const { earliest, first } = firstCalls(calls, 'version');
  const markers = [];
  let highest = null;
  for (const [version, t] of [...first].sort((a, b) => a[1] - b[1])) {
    if (!RELEASE.test(version)) continue;
    const isNewest = highest === null || compareVersions(version, highest) > 0;
    if (isNewest) highest = version;
    if (!isNewest || verdicts[version]?.relevant !== true || t - earliest < WEEK_MS) continue;
    // A user who flips a false verdict by hand may leave the summary out.
    const { summary } = verdicts[version];
    const hasSummary = typeof summary === 'string' && summary !== '';
    const label = `Claude Code ${version}${hasSummary ? `: ${summary}` : ''}`;
    markers.push({ t, kind: 'claude-code', label, version, ...(hasSummary && { summary }), source: 'update' });
  }
  return markers;
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

// Setup changes the mod found at session start, one file per session (see
// checkSetup in mod/hooks/register.ts). Two sessions that start together can find
// the same change, and one file can change several times in a day, so entries for
// the same file and kind on the same local day become one marker.
function getAutoDir() {
  return path.join(path.dirname(getProjectsDir()), 'cc-dashboard', 'changes');
}

function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readAutoEntries() {
  const dir = getAutoDir();
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return []; // no session has recorded a change yet
  }
  const entries = [];
  for (const name of names) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // a file mid-write or edited by hand into invalid JSON
    }
    if (!Array.isArray(parsed)) continue;
    for (const e of parsed) {
      if (!Number.isFinite(e?.t) || typeof e.file !== 'string') continue;
      entries.push(e);
    }
  }
  return entries;
}

function autoMarkers() {
  const groups = new Map();
  for (const e of readAutoEntries()) {
    const kind = KINDS.has(e.kind) ? e.kind : 'other';
    const key = `${e.file}|${kind}|${localDay(e.t)}`;
    if (!groups.has(key)) groups.set(key, { kind, file: e.file, entries: [] });
    groups.get(key).entries.push(e);
  }
  return [...groups.values()].map(({ kind, file, entries }) => {
    entries.sort((a, b) => a.t - b.t);
    const last = entries[entries.length - 1];
    const name = typeof last.name === 'string' && last.name ? last.name : path.basename(file);
    const labels = [...new Set(entries.map((e) => (typeof e.label === 'string' && e.label.trim() ? e.label : 'changed')))];
    return { t: last.t, kind, label: `${name}: ${labels.join('; ')}`, source: 'auto' };
  });
}

// A model marker from settings.json and a first-call model marker on the same day
// are one switch, so the transcript's marker is kept.
function collectMarkers(calls) {
  const { markers, file } = fileMarkers();
  const models = modelMarkers(calls);
  const modelDays = new Set(models.map((m) => localDay(m.t)));
  const auto = autoMarkers().filter((m) => m.kind !== 'model' || !modelDays.has(localDay(m.t)));
  return {
    markers: [...pluginMarkers(), ...models, ...updateMarkers(calls), ...markers, ...auto].sort((a, b) => a.t - b.t),
    changesFile: file,
  };
}

module.exports = { getChangesPath, getAutoDir, pluginMarkers, modelMarkers, updateMarkers, fileMarkers, autoMarkers, collectMarkers };
