'use strict';

const fs = require('fs');
const path = require('path');

// The mod writes one file per subagent here, <agentId>.json, holding the usage of
// each model request the subagent made (mod/hooks/steps.ts). In interactive sessions
// on Claude Code 2.1.280 and later, most subagent responses never get their final
// usage line, so the transcript's output_tokens is the stream-start figure. These
// records hold the real output, and lib/aggregate.js uses it for such a response.
function getAgentUsageDir(configDir) {
  return path.join(configDir, 'cc-dashboard', 'agent-usage');
}

/** The step files directly in `dir`, or [] when it is null, missing or unreadable. Never writes. */
function findStepFiles(dir) {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Joins a step to its transcript call. Only output_tokens changes across a
// response's lines (see addCall in lib/extract.js), so the agent and the input-side
// counts identify the response.
function stepKey(agentId, input, cacheWrite, cacheRead) {
  return `${agentId}:${input}:${cacheWrite}:${cacheRead}`;
}

const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function stepRowSet(ok) {
  return { ok, calls: [], toolUses: [], errors: [], edits: [], prompts: [], commands: [], sessions: Object.create(null), agentSteps: [], minT: null, maxT: null };
}

/**
 * Reads one step file into a row set with empty transcript lists and `agentSteps`.
 * The agent id is the file name. `ok` is false when the file cannot be read or does
 * not parse, which makes the row store read it again at the next refresh: the mod may
 * have been part way through writing it. A step with a missing or invalid count is
 * skipped.
 */
async function readAgentSteps(file) {
  const agentId = path.basename(file, '.json');
  let data;
  try {
    data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return stepRowSet(false);
  }
  const rows = stepRowSet(true);
  for (const step of Array.isArray(data?.steps) ? data.steps : []) {
    if (!step || ![step.t, step.input, step.cacheWrite, step.cacheRead, step.output].every(isCount)) continue;
    const { t, input, cacheWrite, cacheRead, output } = step;
    rows.agentSteps.push({ agentId, t, model: typeof step.model === 'string' ? step.model : null, input, cacheWrite, cacheRead, output });
    if (rows.minT === null || t < rows.minT) rows.minT = t;
    if (rows.maxT === null || t > rows.maxT) rows.maxT = t;
  }
  return rows;
}

/**
 * Adds to `rows`, a step file's new row set, the steps of `earlier` whose stepKey it
 * lacks, and widens minT and maxT to cover them. Returns `rows`. A mod reloaded in a
 * new claude process holds no steps for an agent it continues, so the file it writes
 * holds only the new steps. Without this, those rows would replace the earlier ones.
 * Where both hold a step, the new file's copy wins.
 */
function keepEarlierSteps(rows, earlier) {
  const keyOf = (s) => stepKey(s.agentId, s.input, s.cacheWrite, s.cacheRead);
  const have = new Set(rows.agentSteps.map(keyOf));
  for (const s of earlier) {
    if (have.has(keyOf(s))) continue;
    rows.agentSteps.push(s);
    if (rows.minT === null || s.t < rows.minT) rows.minT = s.t;
    if (rows.maxT === null || s.t > rows.maxT) rows.maxT = s.t;
  }
  return rows;
}

module.exports = { getAgentUsageDir, findStepFiles, readAgentSteps, stepKey, keepEarlierSteps };
