'use strict';

// The "Longest turns" table in the Tool calls panel, from Claude Code's
// turn_duration lines (handleTurnDuration in lib/extract.js).

const TURN_LIMIT = 15;

/**
 * The TURN_LIMIT longest turns, longest first. A turn's calls and cost are its
 * session's calls from the prompt (t - durationMs) to the turn's end, subagent calls
 * included, because they carry the parent's sessionId. A background subagent that
 * kept running after the turn ended is not counted. `calls` holds only calls in the
 * range, so a turn that started before the range shows only its calls inside it.
 */
function longestTurns(turns, calls, titles, firstPrompts) {
  const top = [...turns].sort((a, b) => b.durationMs - a.durationMs).slice(0, TURN_LIMIT);
  const wanted = new Set(top.map((x) => x.sessionId));
  const bySession = new Map();
  for (const c of calls) {
    if (!wanted.has(c.sessionId)) continue;
    if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
    bySession.get(c.sessionId).push(c);
  }
  return top.map((x) => {
    const start = x.t - x.durationMs;
    let n = 0;
    let cost = 0;
    for (const c of bySession.get(x.sessionId) || []) {
      if (c.t < start || c.t > x.t) continue;
      n += 1;
      cost += c.cost;
    }
    return { t: x.t, start, sessionId: x.sessionId, durationMs: x.durationMs, calls: n, cost, title: titles.get(x.sessionId) ?? firstPrompts.get(x.sessionId) ?? null };
  });
}

module.exports = { longestTurns, TURN_LIMIT };
