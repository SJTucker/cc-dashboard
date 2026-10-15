'use strict';

const { median } = require('../public/stats.mjs');

// The "What fills the context" table in the Tool calls panel: tool results grouped
// by what produced them, ranked by the characters they added. Pure, so the
// grouping and the re-read rule are tested without transcripts.

const FILLER_LIMIT = 20;

// A Read after one of these tools changed the file is expected, so it is not a
// re-read.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// The Bash command group (bashGroup in lib/transcript-lines.js), else the tool's
// detail (a file path, a WebFetch host, a Skill name), else the tool name. A Bash
// tool use stored before extract version 9 has no group and falls back to its
// program.
function fillerGroup(use) {
  return use.group ?? use.detail ?? use.name;
}

// The tool_use ids of Reads that read a file the same thread had already read,
// with no write to that file in between. A thread is the main loop of a session or
// one subagent, because each has its own context.
function rereadIds(toolById, resultsById) {
  const threads = new Map();
  for (const [id, r] of resultsById) {
    const use = toolById.get(id);
    if (!use || !use.detail || (use.name !== 'Read' && !WRITE_TOOLS.has(use.name))) continue;
    const thread = `${r.sessionId}\n${r.agentId ?? 'main'}`;
    if (!threads.has(thread)) threads.set(thread, []);
    threads.get(thread).push({ id, t: r.t ?? 0, name: use.name, path: use.detail });
  }
  const ids = new Set();
  for (const list of threads.values()) {
    const read = new Set();
    for (const x of list.sort((a, b) => a.t - b.t)) {
      if (WRITE_TOOLS.has(x.name)) read.delete(x.path);
      else if (read.has(x.path)) ids.add(x.id);
      else read.add(x.path);
    }
  }
  return ids;
}

/**
 * Groups the results in range by tool and fillerGroup. A result whose tool use is not
 * in toolById (before the range, or from a transcript deleted before extract version
 * 9) is left out. Returns the FILLER_LIMIT largest groups and the totals of every
 * joined result.
 */
function contextFillers(toolById, resultsById) {
  const rereads = rereadIds(toolById, resultsById);
  const groups = new Map();
  let chars = 0;
  let results = 0;
  for (const [id, r] of resultsById) {
    const use = toolById.get(id);
    if (!use) continue;
    chars += r.chars;
    results += 1;
    const group = fillerGroup(use);
    const key = `${use.name}\n${group}`;
    if (!groups.has(key)) groups.set(key, { tool: use.name, group, calls: 0, chars: 0, max: 0, sizes: [], sessions: new Set(), rereads: 0 });
    const g = groups.get(key);
    g.calls += 1;
    g.chars += r.chars;
    g.max = Math.max(g.max, r.chars);
    g.sizes.push(r.chars);
    g.sessions.add(r.sessionId);
    if (rereads.has(id)) g.rereads += 1;
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, FILLER_LIMIT)
    .map(({ sizes, sessions, ...g }) => ({ ...g, sessions: sessions.size, median: median(sizes) }));
  return { rows, totals: { chars, results } };
}

module.exports = { contextFillers, FILLER_LIMIT };
