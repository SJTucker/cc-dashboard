'use strict';

const fs = require('fs');
const path = require('path');
const { findStepFiles } = require('./agent-steps');

// A headless session (claude -p) has no transcript. The mod writes one file per such
// session here, <session id>.json, holding the usage of each model request the session
// made (mod/hooks/steps.ts). This module reads those files as call rows, in the shape
// lib/extract.js gives a transcript's calls.
function getHeadlessUsageDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'headless-usage');
}

/** The headless usage files directly in `dir`, or [] when it is null, missing or unreadable. */
function findHeadlessFiles(dir) {
  return findStepFiles(dir);
}

/** True when `file` is under `dir`. */
function isHeadlessFile(file, dir) {
  if (!dir) return false;
  return file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function headlessRowSet(ok) {
  return { headless: true, ok, calls: [], toolUses: [], errors: [], edits: [], results: [], turns: [], prompts: [], commands: [], sessions: Object.create(null), agentSteps: [], minT: null, maxT: null };
}

/**
 * Reads one headless usage file into a row set whose calls are one row per step. The
 * session id is the file name. `ok` is false when the file cannot be read or does not
 * parse, which makes the row store read it again at the next refresh: the mod may have
 * been part way through writing it. A step with a missing or invalid count is skipped.
 * A main-thread step prices its cache write as 1h, the cache lifetime Claude Code asks
 * for there, and a subagent's as 5m.
 */
async function readHeadlessUsage(file) {
  const sessionId = path.basename(file, '.json');
  let data;
  try {
    data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return headlessRowSet(false);
  }
  const rows = headlessRowSet(true);
  for (const step of Array.isArray(data?.steps) ? data.steps : []) {
    if (!step || ![step.t, step.input, step.cacheWrite, step.cacheRead, step.output].every(isCount)) continue;
    const { t, input, cacheWrite, cacheRead, output } = step;
    const agentId = typeof step.agentId === 'string' && step.agentId ? step.agentId : null;
    const main = !agentId;
    const call = {
      key: `headless:${sessionId}:${agentId || 'main'}:${step.turnId}:${step.index}:${t}`,
      t,
      sessionId,
      sidechain: !main,
      model: typeof step.model === 'string' ? step.model : null,
      version: null,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        cache_creation: { ephemeral_1h_input_tokens: main ? cacheWrite : 0, ephemeral_5m_input_tokens: main ? 0 : cacheWrite },
      },
      attributionSkill: null,
      attributionAgent: null,
      tools: [],
    };
    if (agentId) call.agentId = agentId;
    rows.calls.push(call);
    if (rows.minT === null || t < rows.minT) rows.minT = t;
    if (rows.maxT === null || t > rows.maxT) rows.maxT = t;
  }
  rows.sessions[sessionId] = { branches: [], newestBranch: null, title: null, handoffTitle: null, recap: null, firstPrompt: null, reportedCost: null, nonInteractive: true };
  return rows;
}

module.exports = { getHeadlessUsageDir, findHeadlessFiles, isHeadlessFile, readHeadlessUsage };
