'use strict';

// Loaded two ways: index.html loads it as a script before app.js, which makes this
// function a global, and the tests load it with require().

const GROUP_SUMS = ['costUsd', 'costTodayUsd', 'durationMs', 'linesAdded', 'linesRemoved', 'tokens'];

// Turns the sessions of /api/sessions/live (newest lastActiveAt first) into the rows
// of the Live sessions table. Ended sessions of one project collapse into a group
// when the project has two or more of them. Live sessions and idle open sessions stay
// plain rows. A group sorts by its newest session, as if it were one session.
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
  return items.sort((a, b) => lastActive(b) - lastActive(a));
}

function lastActive(item) {
  return item.type === 'group' ? item.lastActiveAt : item.session.lastActiveAt;
}

if (typeof module === 'object') module.exports = { groupSessions };
