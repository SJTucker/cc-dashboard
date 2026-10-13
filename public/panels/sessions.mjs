// The Live sessions panel: today's sessions and the Running now table.
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { formatCost, formatDuration, formatAgo } from '../format.mjs';
import { state } from '../state.mjs';
import { createDrawGuard } from '../guards.mjs';
import { visibleRows, showAllButton, refocusShowAll, keepShowAllFocus } from '../ui/show-all.mjs';

const sessionsGuard = createDrawGuard();

// Today's sessions from the statusline snapshots (see lib/sessions.js). Optional,
// like requestLimits.
export function requestSessions() {
  return getJson('/api/sessions/live', { optional: true });
}

// The suffix of a Live sessions row's Last active cell. Words, not only a colour,
// mark each state: a /clear, any other end, or a response in the last 10 minutes.
function sessionState(s) {
  if (s.ended === 'clear') return ' · cleared';
  if (s.ended) return ' · ended';
  return s.live ? ' · live' : '';
}

// Groups whose sessions are shown one by one, by item.key (groupSessions in
// public/session-groups.js). Kept for the page's lifetime only, and read again by
// every renderSessions call so the 5 s poll keeps it.
const expandedGroups = new Set();
let lastLiveSessions = null;
// Each group row's toggle button by key. renderSessions replaces the tbody, so it
// uses this map to move keyboard focus to the new button for the same group.
let sessionToggles = new Map();
// The Today table shows SESSIONS_LIMIT top-level rows until Show all. A group counts
// once and its expanded child rows do not count. Kept for the page's lifetime, like
// expandedGroups.
const SESSIONS_LIMIT = 10;
let showAllSessions = false;

// Runs on every settled sessions response and on every redraw, like renderLimits, and rebuilds when the payload,
// the expanded groups or the clock minute changed. The minute is there because
// "Last active" moves with the clock even when the payload does not. Hidden off
// Today and when no session has a snapshot, for example without the mod. The Running
// now table hides when no session is live.
export function renderSessions(live) {
  const panel = document.getElementById('sessionsPanel');
  panel.hidden = !live || !live.sessions.length || state.currentDays !== 'today';
  if (panel.hidden) return;
  lastLiveSessions = live;
  // expandedGroups is in the key, so a group toggle's own call redraws.
  sessionsGuard.draw([live, [...expandedGroups], showAllSessions], () => drawSessions(live));
}

function drawSessions(live) {
  const focused = [...sessionToggles].find(([, button]) => button === document.activeElement);
  const toggles = new Map();

  const now = Date.now();
  const cell = (text, cls) => el('td', cls ? { class: cls, text } : { text });
  const lines = (added, removed) => `+${added} −${removed}`;
  // The hexagon, the title and the project · branch line. ⬢ for a live session or a
  // launch group with a live session, ⬡ for any other. The Last active cell still
  // says the state in words. lead goes before the hexagon, such as a group's toggle.
  const titleParts = (s, live, lead = []) => [
    ...lead,
    el('span', { class: 'session-hex', 'aria-hidden': 'true', text: live ? '⬢' : '⬡' }),
    ...(s.title
      ? [el('span', { class: s.titleSource === 'prompt' ? 'session-title from-prompt' : 'session-title', title: s.title, text: s.title })]
      : []),
    contextLine(s),
  ];
  const sessionCell = (s) => el('td', {}, titleParts(s, s.live));
  // The number is text. The bar behind it is one series in one colour, its width the
  // row's share of the day's highest cost (costShare), so it needs no texture. The
  // tooltip carries the whole-session counter, which includes earlier days.
  const costCell = (usd, title, share) => {
    const td = el('td', { class: 'num cost cost-cell', title });
    if (share !== null) {
      const bar = el('span', { class: 'cost-bar', 'aria-hidden': 'true' });
      bar.style.width = `${Math.round(share * 100)}%`;
      td.appendChild(bar);
    }
    td.appendChild(el('span', { class: 'cost-value', text: formatCost(usd) }));
    return td;
  };

  const items = groupSessions(live.sessions);
  const maxCost = Math.max(0, ...live.sessions.map((s) => s.costTodayUsd));

  const sessionRow = (s, cls) => el('tr', cls ? { class: cls } : {}, [
    sessionCell(s),
    cell(String(s.prompts), 'num'),
    cell(formatDuration(s.durationMs), 'num'),
    cell(lines(s.linesAdded, s.linesRemoved), 'num'),
    costCell(s.costTodayUsd, `Session total since it started: ${formatCost(s.costUsd)}`, costShare(s.costTodayUsd, maxCost)),
    cell(formatAgo(s.lastActiveAt, now) + sessionState(s), s.live ? 'is-live' : ''),
  ]);
  // A project group shows the project name. A launch group (sessions of one claude
  // process, split by /clear) reads like its newest session's row with a toggle in
  // front, and says live when one of its sessions is.
  const groupRow = (g) => {
    const launch = g.kind === 'launch';
    const name = launch ? g.head.title || g.project || '—' : g.project || '—';
    const open = expandedGroups.has(g.key);
    const what = launch ? `${g.sessions.length} sessions of ${name}` : `${g.sessions.length} ended sessions of ${name}`;
    const toggle = el('button', {
      type: 'button',
      class: 'row-toggle',
      'aria-expanded': String(open),
      'aria-label': `${open ? 'Collapse' : 'Expand'} ${what}`,
    });
    toggle.addEventListener('click', () => {
      if (expandedGroups.has(g.key)) expandedGroups.delete(g.key);
      else expandedGroups.add(g.key);
      renderSessions(lastLiveSessions);
    });
    toggles.set(g.key, toggle);
    const live = launch && g.live;
    const counts = [[g.cleared, 'cleared'], [g.ended, 'ended']]
      .filter(([n]) => n)
      .map(([n, word]) => ` · ${n} ${word}`)
      .join('');
    const first = launch
      ? el('td', {}, titleParts(g.head, live, [toggle]))
      : el('td', {}, [
        toggle,
        el('span', { class: 'session-hex', 'aria-hidden': 'true', text: '⬡' }),
        document.createTextNode(name),
      ]);
    return el('tr', { class: launch ? 'session-group launch-group' : 'session-group' }, [
      first,
      cell(String(g.prompts), 'num'),
      cell(formatDuration(g.durationMs), 'num'),
      cell(lines(g.linesAdded, g.linesRemoved), 'num'),
      costCell(g.costTodayUsd, `Session totals since they started: ${formatCost(g.costUsd)}`, costShare(g.costTodayUsd, maxCost)),
      cell(formatAgo(g.lastActiveAt, now) + (live ? ' · live' : '') + counts, live ? 'is-live' : ''),
    ]);
  };
  const rows = [];
  for (const item of items) {
    if (item.type === 'session') {
      rows.push([sessionRow(item.session)]);
      continue;
    }
    const group = [groupRow(item)];
    if (expandedGroups.has(item.key)) {
      for (const s of item.sessions) group.push(sessionRow(s, 'session-child'));
    }
    rows.push(group);
  }
  const t = live.total;
  const totalRow = el('tr', { class: 'sessions-total' }, [
    cell('Total'),
    cell(String(live.sessions.reduce((sum, s) => sum + s.prompts, 0)), 'num'),
    // Concurrent sessions overlap, so wall durations do not add up.
    cell('—', 'num'),
    cell(lines(t.linesAdded, t.linesRemoved), 'num'),
    el('td', { class: 'num cost', text: formatCost(t.costTodayUsd) }),
    cell(''),
  ]);
  document.getElementById('sessionsTable').replaceChildren(...visibleRows(rows, SESSIONS_LIMIT, showAllSessions).flat(), totalRow);
  const more = showAllButton(rows.length, SESSIONS_LIMIT, showAllSessions, () => {
    showAllSessions = !showAllSessions;
    renderSessions(lastLiveSessions);
    refocusShowAll('sessionsMore');
  });
  keepShowAllFocus('sessionsMore', () => document.getElementById('sessionsMore').replaceChildren(...(more ? [more] : [])));
  sessionToggles = toggles;
  if (focused) toggles.get(focused[0])?.focus({ preventScroll: true });

  // Running now: live sessions and sessions waiting on you, in a fixed order. State
  // and Doing now come from the mod's activity files (lib/activity.js) and show "—"
  // without the mod.
  const running = runningSessions(live.sessions);
  document.getElementById('runningSessions').hidden = !running.length;
  document.getElementById('runningTable').replaceChildren(...running.map((s) => {
    const label = activityLabel(s.activity);
    // A waiting session's cache countdown (cacheLine) goes under its state. The
    // payload changes once a minute, and the poll redraws it.
    const cache = cacheLine(s.cache, formatCost);
    const stateCell = el('td', label?.attention ? { class: 'is-attention' } : {}, [
      el('span', { text: label ? label.text : '—' }),
      ...(cache ? [el('span', { class: 'cache-line', text: cache })] : []),
    ]);
    return el('tr', {}, [
      sessionCell(s),
      // Waiting uses the brighter text colour as well as its glyph.
      stateCell,
      cell(doingNow(s.activity) ?? '—'),
      costCell(s.costTodayUsd, `Session total since it started: ${formatCost(s.costUsd)}`, null),
      // A waiting session can be past its live window, so only live rows get is-live.
      cell(formatAgo(s.lastActiveAt, now) + sessionState(s), s.live ? 'is-live' : ''),
    ]);
  }));

  const liveCount = live.sessions.filter((s) => s.live).length;
  const endedCount = live.sessions.filter((s) => s.ended).length;
  const ended = endedCount ? ` · ${endedCount} ended` : '';
  document.getElementById('sessionsNote').textContent =
    `${live.sessions.length} today · ${liveCount} live${ended}`;
}

// The line under a session's title: the project, then the git branch. The branch is
// its own span so CSS can cut a long name. Its tooltip has the full name and, for a
// session that switched branch, every branch in order. A review has a branch but no
// branches list. extra is text appended at the end, such as a review's end time.
export function contextLine(item, extra = '') {
  const parts = [document.createTextNode(item.project || '—')];
  if (item.branch) {
    const branches = item.branches || [];
    const tip = branches.length > 1 ? `${item.branch}\nbranches: ${branches.join(' → ')}` : item.branch;
    parts.push(document.createTextNode(' · '), el('span', { class: 'session-branch', title: tip, text: item.branch }));
  }
  if (extra) parts.push(document.createTextNode(extra));
  return el('span', { class: 'session-context' }, parts);
}
