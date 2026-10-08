'use strict';

// Loaded two ways: index.html loads it as a script before app.js, which makes these
// functions globals, and the tests load them with require().

const GROUP_SUMS = ['costUsd', 'costTodayUsd', 'durationMs', 'linesAdded', 'linesRemoved', 'tokens', 'prompts'];

// Cost today of a row of the Today table: a plain session or a group.
function itemCost(item) {
  return item.type === 'group' ? item.costTodayUsd : item.session.costTodayUsd;
}

function lastActive(item) {
  return item.type === 'group' ? item.lastActiveAt : item.session.lastActiveAt;
}

// Turns the sessions of /api/sessions/live (newest lastActiveAt first) into the rows
// of the Today table. Ended sessions of one project collapse into a group when the
// project has two or more of them. Live sessions and idle open sessions stay plain
// rows. Rows are sorted by Cost today, highest first, and a group counts by its
// summed Cost today. Equal costs fall back to the newest lastActiveAt. Only live
// sessions' costs change, so rows rarely move between polls.
function groupSessions(sessions) {
  const endedByProject = new Map();
  for (const s of sessions) {
    if (!s.ended) continue;
    if (!endedByProject.has(s.project)) endedByProject.set(s.project, []);
    endedByProject.get(s.project).push(s);
  }

  const items = [];
  for (const s of sessions) {
    const ended = s.ended ? endedByProject.get(s.project) : null;
    if (!ended || ended.length < 2) {
      items.push({ type: 'session', session: s });
    } else if (ended[0] === s) {
      // The group takes the place of its first (newest) session.
      const group = { type: 'group', project: s.project, sessions: ended };
      for (const key of GROUP_SUMS) group[key] = ended.reduce((sum, e) => sum + e[key], 0);
      group.lastActiveAt = Math.max(...ended.map((e) => e.lastActiveAt));
      group.cleared = ended.filter((e) => e.ended === 'clear').length;
      group.ended = ended.length - group.cleared;
      items.push(group);
    }
  }
  return items.sort((a, b) => itemCost(b) - itemCost(a) || lastActive(b) - lastActive(a));
}

// value as a share of max, from 0 to 1, for the width of a Cost today bar. A day
// with no cost has max 0, and every bar is then empty.
function costShare(value, max) {
  if (!(max > 0)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

// The rows of the Running now table: live sessions and sessions waiting on the user, earliest first span start first,
// so the order does not change while they run. A session with no span today goes
// last. Equal starts fall back to the newest lastActiveAt.
function runningSessions(sessions) {
  const start = (s) => (s.spans?.length ? s.spans[0][0] : Infinity);
  return sessions
    // A session waiting on the user stays listed after its 10 minute live window,
    // because that is when it most needs the user. Ended sessions have no activity.
    .filter((s) => s.live || s.activity?.state === 'waiting')
    .sort((a, b) => {
      const sa = start(a);
      const sb = start(b);
      if (sa === sb) return b.lastActiveAt - a.lastActiveAt;
      return sa < sb ? -1 : 1;
    });
}

// State column of the Running now table. Each state has a glyph and words, so the
// states do not depend on colour. attention marks the state that needs the user.
const ACTIVITY_STATES = {
  working: { glyph: '▶', label: 'working', attention: false },
  waiting: { glyph: '⏸', label: 'waiting on you', attention: true },
};

function activityLabel(activity) {
  if (!activity || !Object.hasOwn(ACTIVITY_STATES, activity.state)) return null;
  const s = ACTIVITY_STATES[activity.state];
  return { ...s, text: `${s.glyph} ${s.label}` };
}

// Doing now column: the running tool's name, then the subagent count. Null when
// nothing is running. The tool's detail is left out: a long Bash command widened the
// column and moved the table on every 5 s poll.
function doingNow(activity) {
  if (!activity) return null;
  const parts = [];
  if (activity.tool) parts.push(activity.tool.name);
  if (activity.subagents > 0) parts.push(`${activity.subagents} ${activity.subagents === 1 ? 'subagent' : 'subagents'}`);
  return parts.length ? parts.join(' · ') : null;
}

if (typeof module === 'object') module.exports = { groupSessions, itemCost, costShare, runningSessions, activityLabel, doingNow };
