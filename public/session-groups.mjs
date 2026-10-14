const GROUP_SUMS = ['costUsd', 'costTodayUsd', 'durationMs', 'linesAdded', 'linesRemoved', 'tokens', 'prompts'];

// Cost today of a row of the Live sessions table: a plain session or a group.
function itemCost(item) {
  return item.type === 'group' ? item.costTodayUsd : item.session.costTodayUsd;
}

function lastActive(item) {
  return item.type === 'group' ? item.lastActiveAt : item.session.lastActiveAt;
}

// Sums, the newest lastActiveAt and the end counts of a group's sessions. cleared
// counts sessions ended by /clear, and ended every other end. An open session of a
// launch group is in neither.
function groupFields(sessions) {
  const fields = {};
  for (const key of GROUP_SUMS) fields[key] = sessions.reduce((sum, s) => sum + s[key], 0);
  fields.lastActiveAt = Math.max(...sessions.map((s) => s.lastActiveAt));
  fields.cleared = sessions.filter((s) => s.ended === 'clear').length;
  fields.ended = sessions.filter((s) => s.ended && s.ended !== 'clear').length;
  return fields;
}

// Turns the sessions of /api/sessions/live (newest lastActiveAt first) into the rows
// of the Live sessions table.
// - Sessions with the same launchId came from one claude process (the mod's
//   statuslineInput). Two or more of them collapse into a launch group, live and open
//   ones included, so a /clear's new session sits with the one it replaced. head is
//   the newest, and the row shows its title.
// - Of the rest, ended sessions of one project collapse into a project group when
//   the project has two or more. Live and idle open sessions stay plain rows.
// A session is in one group at most. key tells groups apart across polls, with a
// prefix so a project named like a launch id cannot collide with it. Rows are
// sorted by Cost today, highest first, and a group counts by its summed Cost today.
// Equal costs fall back to the newest lastActiveAt.
function groupSessions(sessions) {
  const byLaunch = new Map();
  for (const s of sessions) {
    if (s.launchId == null) continue;
    if (!byLaunch.has(s.launchId)) byLaunch.set(s.launchId, []);
    byLaunch.get(s.launchId).push(s);
  }
  const inLaunch = (s) => s.launchId != null && byLaunch.get(s.launchId).length >= 2;

  const endedByProject = new Map();
  for (const s of sessions) {
    if (!s.ended || inLaunch(s)) continue;
    if (!endedByProject.has(s.project)) endedByProject.set(s.project, []);
    endedByProject.get(s.project).push(s);
  }

  const items = [];
  for (const s of sessions) {
    if (inLaunch(s)) {
      const launch = byLaunch.get(s.launchId);
      // The group takes the place of its first (newest) session.
      if (launch[0] !== s) continue;
      items.push({
        type: 'group', kind: 'launch', key: `launch:${s.launchId}`, project: s.project,
        sessions: launch, head: s, live: launch.some((e) => e.live), ...groupFields(launch),
      });
      continue;
    }
    const ended = s.ended ? endedByProject.get(s.project) : null;
    if (!ended || ended.length < 2) {
      items.push({ type: 'session', session: s });
    } else if (ended[0] === s) {
      items.push({
        type: 'group', kind: 'project', key: `project:${s.project ?? ''}`, project: s.project,
        sessions: ended, ...groupFields(ended),
      });
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

// Splits the items of groupSessions into the two bands of the Live sessions table.
// running is { item, session } for every item that holds a live session or one
// waiting on the user, where session is that running session (the item's newest
// running one). It is ordered by the session's first span start, so rows do not
// move while they run. A session with no span today goes last, and equal starts
// fall back to the newest lastActiveAt. earlier is every other item, in the order
// it came in.
function splitBands(items) {
  const start = (s) => (s.spans?.length ? s.spans[0][0] : Infinity);
  // A session waiting on the user stays running after its 10 minute live window,
  // because that is when it most needs the user. Ended sessions have no activity.
  const isRunning = (s) => s.live || s.activity?.state === 'waiting';
  const byStart = (a, b) => {
    const sa = start(a);
    const sb = start(b);
    if (sa === sb) return b.lastActiveAt - a.lastActiveAt;
    return sa < sb ? -1 : 1;
  };
  const running = [];
  const earlier = [];
  for (const item of items) {
    const held = item.type === 'group' ? item.sessions : [item.session];
    const [session] = held.filter(isRunning).sort(byStart);
    if (session) running.push({ item, session });
    else earlier.push(item);
  }
  running.sort((a, b) => byStart(a.session, b.session));
  return { running, earlier };
}

// Cost today of a row as { newest, earlier }: the newest session's share (a group's
// head, or the whole cost of a plain session) and the sum of the group's other
// sessions. Their sum is itemCost(item).
function costSplit(item) {
  if (item.type !== 'group') return { newest: item.session.costTodayUsd, earlier: 0 };
  const head = item.head ?? item.sessions[0];
  const earlier = item.sessions.filter((s) => s !== head).reduce((sum, s) => sum + s.costTodayUsd, 0);
  return { newest: head.costTodayUsd, earlier };
}

// State column of a running row. Each state has a glyph and words, so the
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

// Second line of the State cell for a session waiting on the user: how long its
// prompt cache lasts and what the next reply pays to rebuild it. `cache` is the
// session's cache field from lib/sessions.js, and a negative minutesLeft means it
// expired. `formatUsd` is formatCost from format.mjs, passed in so this file
// does not import format.mjs. Null without a cache.
function cacheLine(cache, formatUsd) {
  if (!cache) return null;
  const cost = cache.rebuildUsd == null ? null : formatUsd(cache.rebuildUsd);
  if (cache.minutesLeft < 0) return cost ? `cache expired · next reply pays ${cost} to rebuild` : 'cache expired';
  const left = cache.minutesLeft === 0 ? 'cache expires in under 1 min' : `cache ${cache.minutesLeft} min left`;
  return cost ? `${left} · ${cost} to rebuild after` : left;
}

// Second part of the State cell: the running tool's name, then the subagent count. Null when
// nothing is running. The tool's detail is left out: a long Bash command widened the
// column and moved the table on every 5 s poll.
function doingNow(activity) {
  if (!activity) return null;
  const parts = [];
  if (activity.tool) parts.push(activity.tool.name);
  if (activity.subagents > 0) parts.push(`${activity.subagents} ${activity.subagents === 1 ? 'subagent' : 'subagents'}`);
  return parts.length ? parts.join(' · ') : null;
}

export { groupSessions, itemCost, costShare, splitBands, costSplit, activityLabel, cacheLine, doingNow };
