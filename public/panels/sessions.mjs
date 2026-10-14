// The Live sessions panel: today's sessions in one table with a Running now band and an Earlier today band.
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { formatCost, formatDuration, formatAgo } from '../format.mjs';
import { state } from '../state.mjs';
import { groupSessions, itemCost, costShare, splitBands, costSplit, activityLabel, cacheLine, doingNow } from '../session-groups.mjs';
import { createDrawGuard } from '../guards.mjs';
import { visibleRows, showAllButton, refocusShowAll, keepShowAllFocus } from '../ui/show-all.mjs';

const sessionsGuard = createDrawGuard();

// The native tooltip of a session title: the title, then Claude Code's away recap
// after a blank line when the session has one.
export function titleTooltip(s) {
  return s.recap ? `${s.title}\n\n${s.recap}` : s.title;
}

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
// public/session-groups.mjs). Kept for the page's lifetime only, and read again by
// every renderSessions call so the 5 s poll keeps it.
const expandedGroups = new Set();
let lastLiveSessions = null;
// Each group row's toggle button by key. renderSessions replaces the tbody, so it
// uses this map to move keyboard focus to the new button for the same group.
let sessionToggles = new Map();
// The Earlier today band shows SESSIONS_LIMIT top-level rows until Show all. A group
// counts once and its expanded child rows do not count. Running now rows are never
// limited. Kept for the page's lifetime, like expandedGroups.
const SESSIONS_LIMIT = 10;
let showAllSessions = false;

// The collapsed bands, by key ('running' or 'earlier'), kept in localStorage so the
// page reopens as it was left. Storage can throw (a private window, blocked site
// data), and then both bands start open.
const COLLAPSED_BANDS_KEY = 'cc-dashboard:collapsed-session-bands';

function loadCollapsedBands() {
  try {
    const keys = JSON.parse(localStorage.getItem(COLLAPSED_BANDS_KEY));
    return new Set(Array.isArray(keys) ? keys : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedBands(keys) {
  try {
    localStorage.setItem(COLLAPSED_BANDS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved. The band still toggles for this page view.
  }
}

const collapsedBands = loadCollapsedBands();

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
  // expandedGroups and collapsedBands are in the key, so a toggle's own call redraws.
  sessionsGuard.draw([live, [...expandedGroups], showAllSessions, [...collapsedBands]], () => drawSessions(live));
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
      ? [el('span', { class: s.titleSource === 'prompt' ? 'session-title from-prompt' : 'session-title', title: titleTooltip(s), text: s.title })]
      : []),
    contextLine(s),
  ];
  const sessionCell = (s) => el('td', {}, titleParts(s, s.live));
  // The number is text. The bars behind it are one series in one colour, their widths
  // the row's shares of the day's highest cost (costShare). The solid bar is the
  // row's newest session. The striped bar after it is the group's earlier sessions,
  // so texture, not colour, tells the two apart. The tooltip carries the
  // whole-session counter, which includes earlier days.
  const costCell = (usd, title, newest, earlier = 0) => {
    const td = el('td', { class: 'num cost cost-cell', title });
    const w1 = Math.round(costShare(newest, maxCost) * 100);
    const w2 = Math.round(costShare(earlier, maxCost) * 100);
    if (w1 > 0 || w2 === 0) {
      const bar = el('span', { class: 'cost-bar', 'aria-hidden': 'true' });
      bar.style.width = `${w1}%`;
      td.appendChild(bar);
    }
    if (w2 > 0) {
      const bar = el('span', { class: 'cost-bar cost-bar-earlier', 'aria-hidden': 'true' });
      bar.style.left = w1 > 0 ? `calc(${w1}% + 2px)` : '0';
      bar.style.width = w1 > 0 ? `calc(${w2}% - 2px)` : `${w2}%`;
      td.appendChild(bar);
    }
    td.appendChild(el('span', { class: 'cost-value', text: formatCost(usd) }));
    return td;
  };
  // The State cell of a running session: its state and what it is doing, then a
  // waiting session's cache countdown (cacheLine) on a second line. The payload
  // changes once a minute, and the poll redraws it. State and Doing now come from
  // the mod's activity files (lib/activity.js) and show "—" without the mod. Every
  // other row has an empty cell.
  const stateCell = (s) => {
    if (!s) return el('td');
    const label = activityLabel(s.activity);
    const doing = doingNow(s.activity);
    const cache = cacheLine(s.cache, formatCost);
    const text = label ? label.text + (doing ? ` · ${doing}` : '') : '—';
    return el('td', label?.attention ? { class: 'is-attention' } : {}, [
      el('span', { text }),
      ...(cache ? [el('span', { class: 'cache-line', text: cache })] : []),
    ]);
  };

  const items = groupSessions(live.sessions);
  // The highest row cost, so a group's two bars together never pass the cell's width.
  const maxCost = Math.max(0, ...items.map(itemCost));

  // running is the session whose state the State cell shows, or null.
  const sessionRow = (s, cls, running = null) => el('tr', cls ? { class: cls } : {}, [
    sessionCell(s),
    stateCell(running),
    cell(String(s.prompts), 'num'),
    cell(formatDuration(s.durationMs), 'num'),
    cell(lines(s.linesAdded, s.linesRemoved), 'num'),
    costCell(s.costTodayUsd, `Session total since it started: ${formatCost(s.costUsd)}`, s.costTodayUsd),
    // A waiting session can be past its live window, so only live rows get is-live.
    cell(formatAgo(s.lastActiveAt, now) + sessionState(s), s.live ? 'is-live' : ''),
  ]);
  // A project group shows the project name. A launch group (sessions of one claude
  // process, split by /clear) reads like its newest session's row with a toggle in
  // front, and says live when one of its sessions is.
  const groupRow = (g, running) => {
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
    const split = costSplit(g);
    return el('tr', { class: launch ? 'session-group launch-group' : 'session-group' }, [
      first,
      stateCell(running),
      cell(String(g.prompts), 'num'),
      cell(formatDuration(g.durationMs), 'num'),
      cell(lines(g.linesAdded, g.linesRemoved), 'num'),
      costCell(
        g.costTodayUsd,
        `Newest session today: ${formatCost(split.newest)} · earlier sessions today: ${formatCost(split.earlier)} · session totals since they started: ${formatCost(g.costUsd)}`,
        split.newest,
        split.earlier,
      ),
      cell(formatAgo(g.lastActiveAt, now) + (live ? ' · live' : '') + counts, live ? 'is-live' : ''),
    ]);
  };
  // The rows of one item: its row, then its sessions when it is an expanded group.
  // running is the item's running session, or null.
  const itemRows = (item, running) => {
    if (item.type === 'session') return [sessionRow(item.session, '', running)];
    const group = [groupRow(item, running)];
    if (expandedGroups.has(item.key)) {
      for (const s of item.sessions) group.push(sessionRow(s, 'session-child', s === running ? s : null));
    }
    return group;
  };
  // A band header: a toggle, the band's name and a count that stays when it is
  // collapsed. Its toggle is in `toggles`, so focus survives the redraw.
  const bandRow = (key, name, count) => {
    const open = !collapsedBands.has(key);
    const toggle = el('button', {
      type: 'button',
      class: 'row-toggle',
      'aria-expanded': String(open),
      'aria-label': `${open ? 'Collapse' : 'Expand'} ${name}`,
    });
    toggle.addEventListener('click', () => {
      if (collapsedBands.has(key)) collapsedBands.delete(key);
      else collapsedBands.add(key);
      saveCollapsedBands(collapsedBands);
      renderSessions(lastLiveSessions);
    });
    toggles.set(`band:${key}`, toggle);
    return el('tr', { class: 'session-band' }, [
      el('td', { colspan: '7' }, [toggle, document.createTextNode(name), el('span', { class: 'count', text: count })]),
    ]);
  };

  const bands = splitBands(items);
  const body = [];
  if (bands.running.length) {
    const waiting = bands.running.filter((r) => r.session.activity?.state === 'waiting').length;
    body.push(bandRow('running', 'Running now', `${bands.running.length}${waiting ? ` · ${waiting} waiting on you` : ''}`));
    if (!collapsedBands.has('running')) {
      for (const { item, session } of bands.running) body.push(...itemRows(item, session));
    }
  }
  let more = null;
  if (bands.earlier.length) {
    const cost = bands.earlier.reduce((sum, item) => sum + itemCost(item), 0);
    body.push(bandRow('earlier', 'Earlier today', `${bands.earlier.length} · ${formatCost(cost)}`));
    if (!collapsedBands.has('earlier')) {
      const rows = bands.earlier.map((item) => itemRows(item, null));
      body.push(...visibleRows(rows, SESSIONS_LIMIT, showAllSessions).flat());
      more = showAllButton(rows.length, SESSIONS_LIMIT, showAllSessions, () => {
        showAllSessions = !showAllSessions;
        renderSessions(lastLiveSessions);
        refocusShowAll('sessionsMore');
      });
    }
  }
  const t = live.total;
  const totalRow = el('tr', { class: 'sessions-total' }, [
    cell('Total'),
    cell(''),
    cell(String(live.sessions.reduce((sum, s) => sum + s.prompts, 0)), 'num'),
    // Concurrent sessions overlap, so wall durations do not add up.
    cell('—', 'num'),
    cell(lines(t.linesAdded, t.linesRemoved), 'num'),
    el('td', { class: 'num cost', text: formatCost(t.costTodayUsd) }),
    cell(''),
  ]);
  document.getElementById('sessionsTable').replaceChildren(...body, totalRow);
  keepShowAllFocus('sessionsMore', () => document.getElementById('sessionsMore').replaceChildren(...(more ? [more] : [])));
  sessionToggles = toggles;
  if (focused) toggles.get(focused[0])?.focus({ preventScroll: true });

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
