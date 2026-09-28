'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Plan usage for the Today range: the two windows that Claude Code's /usage screen
// and statusline show. Claude Code caches its last usage fetch in .claude.json
// under cachedUsageUtilization. That cache is undocumented, so every read here is
// defensive: a shape this code does not expect means no panel, never an error.
// The file also holds account details, and only the fields below leave this module.

const WINDOWS = [
  ['five_hour', 'Current session'],
  ['seven_day', 'Current week (all models)'],
];

// With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside that
// directory. Otherwise the file sits in the home directory, beside ~/.claude/.
function getClaudeJsonPath() {
  const expand = (p) => p.replace(/^~/, os.homedir());
  if (process.env.CLAUDE_JSON) return expand(process.env.CLAUDE_JSON);
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(expand(process.env.CLAUDE_CONFIG_DIR), '.claude.json');
  return path.join(os.homedir(), '.claude.json');
}

function parseReset(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function readLimits(file = getClaudeJsonPath(), now = Date.now()) {
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

module.exports = { getClaudeJsonPath, readLimits };
