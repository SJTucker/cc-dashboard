// The Live sessions panel: today's sessions and the Running now table.
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { formatCost, formatDuration, formatAgo } from '../format.mjs';
import { state } from '../state.mjs';
import { createDrawGuard } from '../guards.mjs';

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

// Projects whose ended sessions are shown one by one. Kept for the page's lifetime
// only, and read again by every renderSessions call so the 5 s poll keeps it.
const expandedProjects = new Set();
let lastLiveSessions = null;
// Each group row's toggle button by project. renderSessions replaces the tbody, so it
// uses this map to move keyboard focus to the new button for the same project.
let sessionToggles = new Map();

// Runs on every renderPayload, like renderLimits, and rebuilds when the payload,
// the expanded groups or the clock minute changed. The minute is there because
// "Last active" moves with the clock even when the payload does not. Hidden off
// Today and when no session has a snapshot, for example with no statusline hook
// set up. The Running now table hides when no session is live.
export function renderSessions(live) {
  const panel = document.getElementById('sessionsPanel');
  panel.hidden = !live || !live.sessions.length || state.currentDays !== 'today';
  if (panel.hidden) return;
  lastLiveSessions = live;
  // expandedProjects is in the key, so a group toggle's own call redraws.
  sessionsGuard.draw([live, [...expandedProjects]], () => drawSessions(live));
}

function drawSessions(live) {
  const focused = [...sessionToggles].find(([, button]) => button === document.activeElement);
  const toggles = new Map();

  const now = Date.now();
  const cell = (text, cls) => el('td', cls ? { class: cls, text } : { text });
  const lines = (added, removed) => `+${added} −${removed}`;
  // ⬢ for a live session, ⬡ for any other. The Last active cell still says the state in words.
  const sessionCell = (s) => el('td', {}, [
    el('span', { class: 'session-hex', 'aria-hidden': 'true', text: s.live ? '⬢' : '⬡' }),
    ...(s.title
      ? [el('span', { class: s.titleSource === 'prompt' ? 'session-title from-prompt' : 'session-title', title: s.title, text: s.title })]
      : []),
    contextLine(s),
  ]);
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
  const groupRow = (g) => {
    const name = g.project || '—';
    const open = expandedProjects.has(g.project);
    const toggle = el('button', {
      type: 'button',
      class: 'row-toggle',
      'aria-expanded': String(open),
      'aria-label': `${open ? 'Collapse' : 'Expand'} ${g.sessions.length} ended sessions of ${name}`,
    });
    toggle.addEventListener('click', () => {
      if (expandedProjects.has(g.project)) expandedProjects.delete(g.project);
      else expandedProjects.add(g.project);
      renderSessions(lastLiveSessions);
    });
    toggles.set(g.project, toggle);
    const counts = [[g.cleared, 'cleared'], [g.ended, 'ended']]
      .filter(([n]) => n)
      .map(([n, word]) => ` · ${n} ${word}`)
      .join('');
    return el('tr', { class: 'session-group' }, [
      el('td', {}, [
        toggle,
        el('span', { class: 'session-hex', 'aria-hidden': 'true', text: '⬡' }),
        document.createTextNode(name),
      ]),
      cell(String(g.prompts), 'num'),
      cell(formatDuration(g.durationMs), 'num'),
      cell(lines(g.linesAdded, g.linesRemoved), 'num'),
      costCell(g.costTodayUsd, `Session totals since they started: ${formatCost(g.costUsd)}`, costShare(g.costTodayUsd, maxCost)),
      cell(formatAgo(g.lastActiveAt, now) + counts),
    ]);
  };
  const rows = [];
  for (const item of items) {
    if (item.type === 'session') {
      rows.push(sessionRow(item.session));
      continue;
    }
    rows.push(groupRow(item));
    if (expandedProjects.has(item.project)) {
      for (const s of item.sessions) rows.push(sessionRow(s, 'session-child'));
    }
  }
  const t = live.total;
  rows.push(el('tr', { class: 'sessions-total' }, [
    cell('Total'),
    cell(String(live.sessions.reduce((sum, s) => sum + s.prompts, 0)), 'num'),
    // Concurrent sessions overlap, so wall durations do not add up.
    cell('—', 'num'),
    cell(lines(t.linesAdded, t.linesRemoved), 'num'),
    el('td', { class: 'num cost', text: formatCost(t.costTodayUsd) }),
    cell(''),
  ]));
  document.getElementById('sessionsTable').replaceChildren(...rows);
  sessionToggles = toggles;
  if (focused) toggles.get(focused[0])?.focus();

  // Running now: live sessions and sessions waiting on you, in a fixed order. State
  // and Doing now come from the mod's activity files (lib/activity.js) and show "—"
  // without the mod.
  const running = runningSessions(live.sessions);
  document.getElementById('runningSessions').hidden = !running.length;
  document.getElementById('runningTable').replaceChildren(...running.map((s) => {
    const label = activityLabel(s.activity);
    return el('tr', {}, [
      sessionCell(s),
      // Waiting uses the brighter text colour as well as its glyph.
      el('td', label?.attention ? { class: 'is-attention', text: label.text } : { text: label ? label.text : '—' }),
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
