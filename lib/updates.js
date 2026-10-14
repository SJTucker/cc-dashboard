'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./files');
const { findJsonlFiles } = require('./transcript-files');
const { forEachLine } = require('./transcript-lines');

// Verdicts on Claude Code releases for the setup changes markers. The mod
// (mod/hooks/register.ts) fetches the changelog and asks Haiku; bin/judge-updates
// runs everything here, so this module is the only writer of updates.json.

const BATCH_SIZE = 20;
const RELEASE = /^\d+\.\d+\.\d+$/;
// '## 2.1.286', '## 2.1.286 (2026-10-01)' and '## [2.1.286]' all name 2.1.286.
const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s|$)/;

function getUpdatesPath(configDir) {
  return path.join(configDir, 'cc-dashboard', 'updates.json');
}

// A '# ' or '## ' line ends the current entry. Only a '## <version>' line starts
// one, so '### ' subheadings stay inside the entry they belong to.
function parseChangelog(text) {
  const entries = new Map();
  let version = null;
  let lines = [];
  const flush = () => {
    if (version) entries.set(version, lines.join('\n').trim());
  };
  for (const line of String(text).split('\n')) {
    if (/^#{1,2}\s/.test(line)) {
      flush();
      const match = VERSION_HEADING.exec(line);
      version = match ? match[1] : null;
      lines = [];
    } else if (version) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

// Every transcript line carries the Claude Code version that wrote it. Only the
// top-level field counts: a tool result can hold an object with its own version.
async function transcriptVersions(projectsDir) {
  const seen = new Set();
  for (const file of findJsonlFiles(projectsDir)) {
    await forEachLine(file, (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof parsed?.version === 'string') seen.add(parsed.version);
    });
  }
  return seen;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// A version with no changelog entry is left for a later run. That covers release
// day, before the changelog has the entry, and dev builds, which never get one.
function pendingVersions(seen, verdicts, changelog) {
  return [...new Set(seen)]
    .filter((v) => RELEASE.test(v) && !Object.hasOwn(verdicts, v) && changelog.has(v))
    .sort(compareVersions);
}

const SYSTEM = `You read Claude Code changelog entries for a usage dashboard. The dashboard measures tokens per call, prompt cache reads, the context sent at session start, and the size of tool results.

For each version, decide whether its entry could change those numbers. A version is relevant when any bullet changes token use, prompt caching, the context window, compaction, tool behaviour or tool output size, subagents, or the default model or effort settings. A version whose bullets only touch the UI, the terminal, IDE extensions, login, installation, or bugs outside those topics is not relevant.

Reply with only a JSON array, one object per version, and no other text:
[{"version": "2.1.286", "relevant": true, "summary": "Subagents now share the parent's prompt cache"}]
"summary" describes only the relevant part of the entry, in at most 15 words. Leave "summary" out when "relevant" is false.`;

function buildPrompt(entries) {
  return {
    system: SYSTEM,
    prompt: entries.map(([version, text]) => `## ${version}\n${text}`).join('\n\n'),
  };
}

// Haiku often wraps JSON in a code fence.
function stripFence(text) {
  return String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

// A version missing from the reply gets no verdict, so a later run asks again.
// A version judged relevant with no summary is recorded as { relevant: true }
// without a summary key.
function parseReply(text, asked) {
  const body = stripFence(text);
  let list;
  try {
    list = JSON.parse(body);
  } catch {
    return {};
  }
  if (!Array.isArray(list)) return {};
  const wanted = new Set(asked);
  const verdicts = {};
  for (const item of list) {
    if (!item || !wanted.has(item.version) || typeof item.relevant !== 'boolean') continue;
    if (!item.relevant) {
      verdicts[item.version] = { relevant: false };
      continue;
    }
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    verdicts[item.version] = summary ? { relevant: true, summary } : { relevant: true };
  }
  return verdicts;
}

// 'missing', 'ok' or 'malformed'. A malformed file is one the user may have been
// editing by hand, so recordVerdicts must not write over it.
function loadVerdicts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', verdicts: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { status: 'ok', verdicts: parsed };
  } catch {
    // falls through to malformed
  }
  return { status: 'malformed', verdicts: {} };
}

function readVerdicts(file) {
  try {
    return loadVerdicts(file).verdicts;
  } catch {
    return {};
  }
}

// Re-reads the file just before writing, and an entry already in the file at that
// point is kept. Two runs that overlap can still drop one run's new entries, because
// a write can land between the read and the rename. A later run judges those
// versions again. The rename makes the write atomic: a reader sees the old file or
// the new one, never half of one.
function recordVerdicts(verdicts, file, now = Date.now()) {
  const { status, verdicts: current } = loadVerdicts(file);
  if (status === 'malformed') throw new Error(`${file} is not a JSON object; fix or delete it`);
  const judgedAt = new Date(now).toISOString();
  const added = [];
  for (const [version, verdict] of Object.entries(verdicts)) {
    if (Object.hasOwn(current, version)) continue;
    current[version] = { ...verdict, judgedAt };
    added.push(version);
  }
  if (!added.length) return added;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(current, null, 2) + '\n');
  return added;
}

module.exports = {
  BATCH_SIZE,
  getUpdatesPath,
  parseChangelog,
  transcriptVersions,
  compareVersions,
  pendingVersions,
  buildPrompt,
  stripFence,
  parseReply,
  readVerdicts,
  recordVerdicts,
};
