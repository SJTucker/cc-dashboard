import { state, shown } from './state.mjs';
import { getJson } from './api.mjs';
import { createSequence, createDrawGuard } from './guards.mjs';
import {
  formatCost, formatTokens, formatPercent, formatDuration, formatAgo, localDateStr, costPerDay,
  shortDate, fullDate, axisTokens, axisCost, escapeHtml,
} from './format.mjs';
import {
  el, svgEl, hideTooltip, withTooltip, chartWidth, spinnerNode,
} from './dom.mjs';
import { DETAIL_LIMIT, LIVE_WINDOW_MS, REVIEW_DAYS, LIMIT_WARN_PERCENT } from './constants.mjs';
import {
  TOKEN_SERIES, appendPatternDefs, fillFor, segmentTexture,
} from './charts/palette.mjs';
import { drawHBars } from './charts/hbars.mjs';
import { drawBarChart, drawCumulativeChart } from './charts/bar.mjs';
import { drawModelDailyChart } from './charts/stacked.mjs';
import { drawLogLineChart, drawTokenLegend } from './charts/line.mjs';
import { drawActivityHeatmap } from './charts/heatmap.mjs';
import { drawModelMix } from './charts/donut.mjs';
import { drawSplitBar } from './charts/split.mjs';
import {
  WEEK_MS, markerDate, markerIcon, timeDomain, drawSessionStartChart, drawMetricChart,
} from './charts/setup-changes.mjs';

// A detail row for Read, Write or Edit is an absolute file path. The name cell
// truncates from the right, which on a path shows the part every row has in common,
// so the basename is displayed and the full path goes in the tooltip.
function toolRowLabel(name) {
  return name.startsWith('/') ? name.split('/').pop() || name : name;
}

// Which tool the detail column is showing. Held across renders so a range switch
// or a live poll does not throw the reader back to the first tool; it falls back
// to the busiest tool when the selected one has no calls in the new range.
let selectedTool = null;

// Name of the tool renderToolErrors last drew the error list for. A 5s poll on the
// Today range calls renderToolErrors again for the same tool and must not close a
// group the reader opened; clicking a different tool in the bars above is a real
// change of subject and starts closed. Paired with errorGroupKey below, which is
// stored on each <details> so a rebuilt element can be matched back to its group.
let toolErrorsFor = null;

function errorGroupKey(g) {
  return `${g.cause}\n${g.message}`;
}

// The keys of currently open groups, or an empty set when the tool just changed.
// A poll rebuilds the whole list every time (see renderToolErrors), so "open" has
// to be read off the DOM before the old elements are replaced.
function openErrorKeys(list, tool) {
  if (toolErrorsFor !== tool.name) {
    toolErrorsFor = tool.name;
    return new Set();
  }
  return new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.key));
}

// Error text comes from tool results on disk, so it only ever reaches the page
// through textContent. Each group is a <details> so the full example opens on
// click or keyboard, which a hover tooltip cannot do on a touch screen.
function renderToolErrors(tool) {
  const title = document.getElementById('toolErrorTitle');
  const causes = document.getElementById('toolErrorCauses');
  const list = document.getElementById('toolErrorList');
  const openKeys = openErrorKeys(list, tool);
  causes.replaceChildren();
  list.replaceChildren();
  title.hidden = !tool.errors;
  if (!tool.errors) return;

  title.textContent = `Errors · ${tool.errors.toLocaleString('en-US')}`;
  for (const { cause, count } of tool.errorCauses) {
    causes.appendChild(el('span', { class: 'error-cause' }, [
      document.createTextNode(cause),
      el('b', { text: count.toLocaleString('en-US') }),
    ]));
  }
  for (const g of tool.errorGroups) {
    const key = errorGroupKey(g);
    const summary = el('summary', {}, [
      el('span', { class: 'error-count', text: g.count.toLocaleString('en-US') }),
      el('span', { class: 'error-message', text: g.message }),
    ]);
    const when = el('div', { class: 'error-when', text: `${g.cause} · latest ${new Date(g.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
    const group = el('details', { class: 'error-group', 'data-key': key }, [summary, when, el('pre', { class: 'error-example', text: g.example })]);
    group.open = openKeys.has(key);
    list.appendChild(group);
  }
  const shown = tool.errorGroups.reduce((n, g) => n + g.count, 0);
  if (shown < tool.errors) {
    list.appendChild(el('div', { class: 'panel-note', text: `${(tool.errors - shown).toLocaleString('en-US')} more in smaller groups.` }));
  }
}

// How the tool lists draw a row: call counts, with the error rate beside a tool
// that had errors.
const TOOL_BARS = {
  size: (row) => row.calls,
  label: (row) => toolRowLabel(row.name),
  value: (row) => (row.errors
    ? `${row.calls.toLocaleString('en-US')} · ${((row.errors / row.calls) * 100).toFixed(1)}% err`
    : row.calls.toLocaleString('en-US')),
  tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${row.calls.toLocaleString('en-US')} calls`
    + (row.errors ? `<br>${row.errors.toLocaleString('en-US')} returned an error` : ''),
  valueClass: 'usage-pct usage-count',
  empty: 'No tool calls in this range.',
};

function renderTools(tools) {
  const panel = document.getElementById('toolPanel');
  panel.hidden = !tools.length;
  if (!tools.length) return;

  if (!tools.some((t) => t.name === selectedTool)) selectedTool = tools[0].name;
  const current = tools.find((t) => t.name === selectedTool);

  const shown = tools.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('toolBars'), shown, {
    ...TOOL_BARS,
    scaleMax: Math.max(...shown.map((t) => t.calls)),
    onSelect: (name) => {
      selectedTool = name;
      renderTools(tools);
    },
    selectedName: selectedTool,
  });

  document.getElementById('toolDetailTitle').textContent = `Inside ${toolRowLabel(current.name)}`;
  const details = current.details;
  drawHBars(document.getElementById('toolDetailBars'), details, {
    ...TOOL_BARS,
    scaleMax: details.length ? Math.max(...details.map((d) => d.calls)) : 0,
  });
  document.getElementById('toolDetailNote').textContent = details.length
    ? ''
    : 'No breakdown for this tool.';
  renderToolErrors(current);
}

// rtk figures are deliberately not folded into any summary card. They count output
// bytes rtk filtered before the text reached the model, estimated by rtk's own
// tokeniser; the cards above count tokens Anthropic billed. Adding one to the other
// would produce a number that means nothing.
// Held across renders for the same reason selectedTool is: a range switch or a live
// poll should not throw the reader back to the first command.
let selectedRtkCommand = null;

// How the rtk lists draw a row: scaled by tokens saved rather than by call count,
// because "which commands is rtk helping with" is a question about tokens. A
// command with 15,000 cheap calls and one with 127 expensive ones both show up
// honestly this way.
const RTK_BARS = {
  size: (row) => row.saved,
  value: (row) => formatTokens(row.saved),
  tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${formatTokens(row.saved)} filtered out`
    + `<br>${row.calls.toLocaleString('en-US')} ${row.calls === 1 ? 'call' : 'calls'}`,
  valueClass: 'usage-pct usage-count',
  empty: 'No rtk commands in this range.',
};

function renderRtkCommands(commands) {
  if (!commands.some((c) => c.name === selectedRtkCommand)) {
    selectedRtkCommand = commands[0].name;
  }
  const current = commands.find((c) => c.name === selectedRtkCommand);

  const shown = commands.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('rtkCommandBars'), shown, {
    ...RTK_BARS,
    scaleMax: Math.max(...shown.map((c) => c.saved)),
    onSelect: (name) => {
      selectedRtkCommand = name;
      renderRtkCommands(commands);
    },
    selectedName: selectedRtkCommand,
  });

  document.getElementById('rtkDetailTitle').textContent = `Inside rtk ${current.name}`;
  const details = current.details.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('rtkDetailBars'), details, {
    ...RTK_BARS,
    scaleMax: details.length ? Math.max(...details.map((d) => d.saved)) : 0,
  });
}

// "Resets 5:20pm" today, "Resets Oct 4 at 5am" on another day, worded the way
// Claude Code's /usage screen words it.
function formatReset(ms) {
  // The cache's resets_at lands a few milliseconds either side of the minute
  // (e.g. 22:19:59.941Z), so round to the nearest minute before formatting.
  const d = new Date(Math.round(ms / 60000) * 60000);
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
    .replace(/\s/g, '')
    .toLowerCase();
  if (localDateStr(d) === localDateStr(new Date())) return `Resets ${time}`;
  return `Resets ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`;
}

// The usage-cache source only refreshes while Claude Code runs, and /usage itself
// stops trusting cached bars after 60 minutes, so the panel says so past that age.
// The statusline source changes after every API response, so it only reaches this
// age when no session has run for an hour. The same threshold applies to it.
const LIMITS_STALE_MS = 60 * 60 * 1000;

// Plan usage describes right now, not a date range. The panel shows only on
// Today, and the 75% warning banner shows on every range. Like rtk it is
// optional: a failure, including a 500, resolves to null and hides both.
function requestLimits() {
  return getJson('/api/limits', { optional: true });
}

// One draw guard per panel that renderPayload draws on every settled response:
// Plan usage, the limits banner, Live sessions and Session reviews.
// redrawCharts leaves them alone, because a change of width does not change a
// table.
const limitsGuard = createDrawGuard();
const bannerGuard = createDrawGuard();
const sessionsGuard = createDrawGuard();
const reviewsGuard = createDrawGuard();

// Today's share of the weekly limit, as a row in the Plan usage panel. The bar fills
// against 100% of the week, like the weekly rows above it, so the two scales match.
// On a workday a tick marks the day's budget. A weekend has no budget and no tick.
function dailyShareRow(today) {
  const notes = [];
  if (today.budget == null) {
    notes.push('weekend, no budget');
  } else {
    notes.push(`budget ${today.budget}%`);
    if (today.rollingBudget != null) {
      const days = `${today.workdaysLeft} workday${today.workdaysLeft === 1 ? '' : 's'} to reset`;
      notes.push(`rolling ${Math.round(today.rollingBudget)}% (${days})`);
    }
  }
  if (today.from === 'first-reading') notes.push("counted from today's first reading");
  if (today.from === 'reset') notes.push('counted from the weekly reset');
  if (today.from === 'no-reading-today') notes.push('no API response yet today');

  const meter = shareMeter(today);
  const fill = el('i');
  fill.style.width = meter.fill + '%';
  const track = el('span', { class: 'usage-track' }, [fill]);
  if (meter.tick != null) {
    const tick = el('b', { class: 'budget-tick', title: `budget ${meter.tick}%` });
    tick.style.left = meter.tick + '%';
    track.appendChild(tick);
  }
  return el('div', { class: 'limit-row' }, [
    el('span', { class: 'limit-name', text: 'Today (share of the week)' }),
    track,
    el('span', { class: 'limit-pct', text: `${Math.round(today.share)}% of the week` }),
    el('span', { class: 'limit-reset', text: notes.join(' · ') }),
  ]);
}

function renderLimits(limits) {
  const panel = document.getElementById('limitsPanel');
  panel.hidden = !limits || state.currentDays !== 'today';
  if (panel.hidden) return;
  limitsGuard.draw(limits, () => drawLimits(limits));
}

function drawLimits(limits) {
  const rows = document.getElementById('limitsRows');
  rows.replaceChildren();
  for (const limit of limits.limits) {
    const fill = el('i');
    fill.style.width = Math.min(100, Math.max(0, limit.percent)) + '%';
    rows.appendChild(el('div', { class: 'limit-row' }, [
      el('span', { class: 'limit-name', text: limit.label }),
      el('span', { class: 'usage-track' }, [fill]),
      el('span', { class: 'limit-pct', text: `${Math.round(limit.percent)}% used` }),
      el('span', { class: 'limit-reset', text: limit.resetsAt == null ? '' : formatReset(limit.resetsAt) }),
    ]));
  }
  if (limits.today) rows.appendChild(dailyShareRow(limits.today));
  const asOf = new Date(limits.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stale = Date.now() - limits.fetchedAt > LIMITS_STALE_MS
    ? ' · may be stale'
    : '';
  document.getElementById('limitsNote').textContent = `as of ${asOf} (${zone})${stale}`;
}

// Today's sessions from the statusline snapshots (see lib/sessions.js). Optional, like requestLimits.
function requestSessions() {
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
function renderSessions(live) {
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

// Session timeline: one lane per session that has activity today (laneLayout in
// public/chart-geometry.js), with a bar per span. A live session's bars are solid
// and, when its last call was within the last 10 minutes, its last bar ends in an
// arrowhead at now. Every other session's bars carry the
// diagonal texture. The key in the p.panel-note under the chart (public/index.html)
// says so in words, so the two kinds never depend on colour. SVG fills need a literal colour for the texture pattern,
// so TIMELINE_COLOR repeats --accent-cyan from public/style.css.
const TIMELINE_COLOR = '#3fe0ff';
const TIMELINE_LANE_HEIGHT = 22;
const TIMELINE_BAR_HEIGHT = 10;
const TIMELINE_AXIS_HEIGHT = 20;
const TIMELINE_GUTTER = 200;
const TIMELINE_RIGHT_PAD = 10;

// The redraw tears down the SVG, which would kill an open tooltip, so an unchanged
// payload within the same minute and width skips it. The minute is in the signature
// because the "now" line and the open bars move with the clock.
let timelineSignature = null;

function cutLabel(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The line under a session's title: the project, then the git branch. The branch is
// its own span so CSS can cut a long name. Its tooltip has the full name and, for a
// session that switched branch, every branch in order. A review has a branch but no
// branches list. extra is text appended at the end, such as a review's end time.
function contextLine(item, extra = '') {
  const parts = [document.createTextNode(item.project || '—')];
  if (item.branch) {
    const branches = item.branches || [];
    const tip = branches.length > 1 ? `${item.branch}\nbranches: ${branches.join(' → ')}` : item.branch;
    parts.push(document.createTextNode(' · '), el('span', { class: 'session-branch', title: tip, text: item.branch }));
  }
  if (extra) parts.push(document.createTextNode(extra));
  return el('span', { class: 'session-context' }, parts);
}

function timelineTooltip(s, bar) {
  const name = s.title || s.project || '—';
  // With a title, the line under it is project · branch. Without one the project is
  // already the name, so the line is the branch alone.
  const context = (s.title ? [s.project, s.branch] : [s.branch]).filter(Boolean);
  const contextHtml = context.length ? `${context.map(escapeHtml).join(' · ')}<br>` : '';
  const range = bar.start === bar.end ? clockTime(bar.start) : `${clockTime(bar.start)} – ${clockTime(bar.end)}`;
  return `<b>${escapeHtml(name)}</b><br>${contextHtml}${range}<br>${formatCost(s.costTodayUsd)} today · ${s.prompts} ${s.prompts === 1 ? 'prompt' : 'prompts'}`;
}

function renderTimeline(live) {
  const panel = document.getElementById('timelinePanel');
  panel.hidden = !live || !live.sessions.some((s) => s.spans.length) || state.currentDays !== 'today';
  if (panel.hidden) {
    timelineSignature = null;
    return;
  }
  const container = document.getElementById('timelineChart');
  const width = chartWidth(container);
  const now = Date.now();
  const signature = JSON.stringify([
    width,
    Math.floor(now / 60_000),
    live.sessions.map((s) => [s.spans, s.live, s.title, s.titleSource, s.project, s.branch, s.costTodayUsd, s.prompts]),
  ]);
  if (signature === timelineSignature) return;
  timelineSignature = signature;
  hideTooltip();

  const starts = live.sessions.flatMap((s) => s.spans.map((span) => span[0]));
  const ticks = hourTicks(Math.min(...starts), now);
  const domain = [ticks[0], ticks[ticks.length - 1]];
  const gutter = Math.min(TIMELINE_GUTTER, Math.round(width * 0.4));
  const xOf = (t) => gutter + ((t - domain[0]) / (domain[1] - domain[0])) * (width - gutter - TIMELINE_RIGHT_PAD);
  const lanes = laneLayout(live.sessions, xOf, now, 3, LIVE_WINDOW_MS);
  const plotHeight = lanes.length * TIMELINE_LANE_HEIGHT;
  const height = plotHeight + TIMELINE_AXIS_HEIGHT;

  const liveLanes = lanes.filter((l) => l.session.live).length;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: 'img',
    'aria-label': `Session timeline: ${lanes.length} ${lanes.length === 1 ? 'session' : 'sessions'} today, ${liveLanes} live`,
  });
  appendPatternDefs(svg, 'timeline', [{ texture: 'diag', color: TIMELINE_COLOR }]);

  const step = labelStep(ticks.length, width - gutter);
  ticks.forEach((t, i) => {
    svg.appendChild(svgEl('line', { x1: xOf(t), x2: xOf(t), y1: 0, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 }));
    if (i % step !== 0) return;
    const label = svgEl('text', { class: 'axis-label', x: xOf(t), y: height - 4, 'text-anchor': 'middle' });
    label.textContent = `${String(new Date(t).getHours()).padStart(2, '0')}:00`;
    svg.appendChild(label);
  });

  const maxChars = Math.floor((gutter - 8 - 14) / 6.6);
  for (const { session: s, lane, bars } of lanes) {
    const top = lane * TIMELINE_LANE_HEIGHT;
    const mid = top + TIMELINE_LANE_HEIGHT / 2;
    const label = svgEl('text', { class: 'timeline-label', x: 0, y: mid + 4 });
    if (s.titleSource === 'prompt') label.classList.add('prompt-title');
    const fullName = s.title || s.project || '—';
    const glyph = svgEl('tspan', { 'aria-hidden': 'true' });
    glyph.textContent = s.live ? '⬢' : '⬡';
    const name = svgEl('title', {});
    name.textContent = fullName;
    label.append(glyph, ` ${cutLabel(fullName, maxChars)}`, name);
    svg.appendChild(label);

    const fill = fillFor('timeline', s.live ? 'solid' : 'diag', TIMELINE_COLOR);
    for (const bar of bars) {
      // laneLayout's 3px minimum shows half of the 6px diagonal texture tile.
      if (!s.live) bar.width = Math.max(6, bar.width);
      const y = mid - TIMELINE_BAR_HEIGHT / 2;
      svg.appendChild(withTooltip(svgEl('rect', {
        class: 'timeline-bar', x: bar.x, y, width: bar.width, height: TIMELINE_BAR_HEIGHT, rx: 3, fill,
      }), timelineTooltip(s, bar)));
      if (bar.open) {
        const tip = bar.x + bar.width;
        svg.appendChild(svgEl('path', {
          class: 'timeline-arrow', d: `M${tip},${y - 1} L${tip + 6},${mid} L${tip},${y + TIMELINE_BAR_HEIGHT + 1} Z`, fill: TIMELINE_COLOR,
        }));
      }
    }
  }

  svg.appendChild(svgEl('line', {
    class: 'timeline-now', x1: xOf(now), x2: xOf(now), y1: 0, y2: plotHeight,
    stroke: 'var(--text-secondary)', 'stroke-width': 1, 'stroke-dasharray': '4 3',
  }));
  container.replaceChildren(svg);

  document.getElementById('timelineNote').textContent =
    `${lanes.length} ${lanes.length === 1 ? 'session' : 'sessions'} today · ${liveLanes} live`;
}

// Reviews of ended sessions from the last REVIEW_DAYS days (see lib/review.js). A
// server error resolves to { error } so the panel shows the reason. A network
// failure (status 0) resolves to null and hides the panel, like requestSessions.
function requestReviews() {
  return getJson('/api/reviews').then((reviews) => (reviews.error && reviews.status === 0 ? null : reviews));
}

const REVIEW_KINDS = {
  'claude-md': 'CLAUDE.md',
  'skill-or-hook': 'Skill or hook',
  'token-waste': 'Token waste',
  workflow: 'Workflow',
};

// "5m ago" or a time for today, and a weekday with a time for earlier days.
function reviewTime(ms, now) {
  if (localDateStr(new Date(ms)) === localDateStr(new Date(now))) return formatAgo(ms, now);
  // A review can be about 8 days old, so past 6 days a weekday alone is ambiguous.
  const older = now - ms > 6 * 24 * 60 * 60 * 1000;
  const parts = older ? { month: 'short', day: 'numeric' } : { weekday: 'short' };
  return new Date(ms).toLocaleString([], { ...parts, hour: '2-digit', minute: '2-digit' });
}

// The last reviews payload shown. Dismiss and undo change it in place and redraw
// without a request.
let lastReviews = null;
// Counts local dismiss and undo actions. fetchAll swaps a response that was
// requested before the latest action for lastReviews, so a slow poll cannot put a
// dismissed suggestion back on screen. The next poll shows the saved state.
let reviewMutations = 0;
// Session ids whose "N dismissed" list is showing, and session ids whose collapsed
// all-dismissed review is expanded. The 5 s redraw reads both.
const reviewDismissedShown = new Set();
const reviewExpanded = new Set();
// Session id -> "Copied" or "Copy failed" while it shows, for the label's 2 s.
const reviewCopyResults = new Map();
// The control to focus after the next draw, set by an action that removes the
// control the user was on. Otherwise the focused control is found again by its key.
let reviewFocusKey = null;
// The text of a failed dismiss or undo, shown in #reviewsStatus.
let reviewActionError = null;

const reviewButton = (label, focusKey, ariaLabel, onClick, cls = 'refresh-btn') => {
  const button = el('button', { type: 'button', class: cls, text: label, 'data-review-focus': focusKey });
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
};

const suggestionName = (s) => `${REVIEW_KINDS[s.kind] || s.kind}: ${s.text.length > 80 ? `${s.text.slice(0, 79)}…` : s.text}`;

async function copyReviewPrompt(id, prompt) {
  reviewCopyResults.set(id, await navigator.clipboard.writeText(prompt).then(() => 'Copied', () => 'Copy failed'));
  const show = (label) => {
    const button = [...document.querySelectorAll('[data-review-focus]')].find((b) => b.dataset.reviewFocus === `copy:${id}`);
    if (button) button.textContent = label;
  };
  show(reviewCopyResults.get(id));
  setTimeout(() => {
    reviewCopyResults.delete(id);
    show('Copy prompt');
  }, 2000);
}

// POSTs a dismissal, or sends DELETE when reason is null, then updates the shown
// review from the answer and redraws. A failure leaves the suggestion as it was.
async function changeSuggestion(review, suggestion, reason) {
  const url = `/api/reviews/${encodeURIComponent(review.sessionId)}/suggestions/${suggestion.idx}/dismiss`;
  const init = reason
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }
    : { method: 'DELETE' };
  const res = await fetch(url, init).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  if (!res || !res.ok || !body || !body.ok) {
    reviewActionError = `Could not ${reason ? 'dismiss' : 'undo the dismissal of'} "${suggestionName(suggestion)}": ${(body && body.error) || 'the request failed'}`;
  } else {
    reviewActionError = null;
    // A poll that landed during the request replaced lastReviews, so the suggestion
    // captured at click time may no longer be the one on screen. Write to the current
    // one, found by session and idx.
    const currentReview = lastReviews?.reviews?.find((r) => r.sessionId === review.sessionId) ?? review;
    const current = currentReview.suggestions.find((s) => s.idx === suggestion.idx);
    for (const target of new Set([suggestion, current])) {
      if (!target) continue;
      target.dismissedAt = body.dismissedAt;
      target.reason = body.reason;
    }
    reviewMutations++;
    // The button the user pressed is about to leave the page. Dismiss moves focus to
    // the next open suggestion's Done button, else to the control that replaced it.
    // Undo moves focus to the restored suggestion's Done button.
    const nextOpen = openSuggestions(currentReview).find((s) => s.idx !== suggestion.idx);
    if (!reason) reviewFocusKey = `done:${review.sessionId}:${suggestion.idx}`;
    else if (nextOpen) reviewFocusKey = `done:${review.sessionId}:${nextOpen.idx}`;
    else reviewFocusKey = allDismissed(currentReview) ? `toggle:${review.sessionId}` : `shown:${review.sessionId}`;
  }
  renderReviews(lastReviews);
}

function toggleSet(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
  renderReviews(lastReviews);
}

function dismissedList(review) {
  return el('ul', { class: 'review-dismissed' }, dismissedSuggestions(review).map((s) => el('li', {}, [
    el('span', { class: 'review-kind', text: REVIEW_KINDS[s.kind] || s.kind }),
    document.createTextNode(` ${s.text} `),
    el('span', { class: 'review-dismissal', text: `(${dismissalText(s)})` }),
    document.createTextNode(' '),
    reviewButton('Undo', `undo:${review.sessionId}:${s.idx}`, `Undo dismissal: ${suggestionName(s)}`, () => changeSuggestion(review, s, null)),
  ])));
}

function openList(review) {
  return el('ul', { class: 'review-suggestions' }, openSuggestions(review).map((s) => el('li', {}, [
    el('span', { class: 'review-kind', text: REVIEW_KINDS[s.kind] || s.kind }),
    document.createTextNode(` ${s.text} `),
    el('span', { class: 'review-actions' }, [
      reviewButton('Done', `done:${review.sessionId}:${s.idx}`, `Mark done: ${suggestionName(s)}`, () => changeSuggestion(review, s, 'done')),
      reviewButton('Not useful', `notuseful:${review.sessionId}:${s.idx}`, `Dismiss as not useful: ${suggestionName(s)}`, () => changeSuggestion(review, s, 'not_useful')),
    ]),
  ])));
}

// The body of one review: the open suggestions, then a "N dismissed · Show" line
// with the dismissed list under it when shown. A review with every suggestion
// dismissed shows a toggle line above the dismissed list instead.
function reviewBody(r) {
  if (r.status === 'failed') return [el('p', { class: 'review-empty', text: `Review failed: ${r.error || 'no reason recorded'}` })];
  if (!r.suggestions.length) return [el('p', { class: 'review-empty', text: 'No suggestions' })];
  if (allDismissed(r)) {
    const hide = reviewButton(`All ${r.suggestions.length} dismissed · Hide`, `toggle:${r.sessionId}`, null, () => toggleSet(reviewExpanded, r.sessionId), 'review-toggle');
    hide.setAttribute('aria-expanded', 'true');
    return [hide, dismissedList(r)];
  }
  const parts = [openList(r)];
  const dismissed = dismissedSuggestions(r);
  if (dismissed.length) {
    const shown = reviewDismissedShown.has(r.sessionId);
    const toggle = reviewButton(shown ? 'Hide' : 'Show', `shown:${r.sessionId}`, `${shown ? 'Hide' : 'Show'} ${dismissed.length} dismissed ${dismissed.length === 1 ? 'suggestion' : 'suggestions'}`, () => toggleSet(reviewDismissedShown, r.sessionId), 'review-toggle');
    toggle.setAttribute('aria-expanded', String(shown));
    parts.push(el('p', { class: 'review-dismissed-line' }, [document.createTextNode(`${dismissed.length} dismissed · `), toggle]));
    if (shown) parts.push(dismissedList(r));
  }
  return parts;
}

// A review with every suggestion dismissed is one button line until expanded. The
// button is keyboard-operable and carries aria-expanded.
function collapsedReview(r, now) {
  const name = r.title || r.project || r.sessionId;
  const label = `${name} · ended ${reviewTime(r.endedAt ?? r.reviewedAt, now)} · all ${r.suggestions.length} ${r.suggestions.length === 1 ? 'suggestion' : 'suggestions'} dismissed · Show`;
  const button = reviewButton(label, `toggle:${r.sessionId}`, null, () => toggleSet(reviewExpanded, r.sessionId), 'review-toggle');
  button.setAttribute('aria-expanded', 'false');
  return el('li', { class: 'review review-collapsed' }, [button]);
}

// Shown on every range, because a review belongs to a session, not to a day.
// Hidden when the request failed or no session was reviewed in the last 7 days.
// A server error shows its text in place of the list.
function renderReviews(data) {
  lastReviews = data;
  // The key holds every input of the draw, so a dismiss, an undo, a Show or Hide
  // toggle and a failed action each redraw from their own call.
  reviewsGuard.draw(
    [data, reviewMutations, [...reviewDismissedShown], [...reviewExpanded], reviewActionError],
    () => drawReviews(data)
  );
}

function drawReviews(data) {
  const panel = document.getElementById('reviewsPanel');
  const status = document.getElementById('reviewsStatus');
  const list = document.getElementById('reviewsList');
  if (data && data.error) {
    panel.hidden = false;
    status.hidden = false;
    status.textContent = `Could not read session reviews: ${data.error}`;
    list.replaceChildren();
    document.getElementById('reviewsNote').textContent = '';
    return;
  }
  panel.hidden = !data || !data.reviews.length;
  if (panel.hidden) return;

  const active = document.activeElement;
  const focusKey = reviewFocusKey || (active && list.contains(active) ? active.dataset.reviewFocus : null);
  reviewFocusKey = null;
  status.hidden = !reviewActionError;
  status.textContent = reviewActionError || '';

  const now = Date.now();
  const items = data.reviews.map((r) => {
    if (allDismissed(r) && !reviewExpanded.has(r.sessionId)) return collapsedReview(r, now);
    const ended = ` · ended ${reviewTime(r.endedAt ?? r.reviewedAt, now)}`;
    const head = el('div', { class: 'review-head' }, [
      ...(r.title ? [el('span', { class: 'session-title', title: r.title, text: r.title })] : []),
      contextLine(r, ended),
    ]);
    const prompt = reviewPrompt(r);
    let source = null;
    if (r.transcript) {
      const children = [el('span', { class: 'review-path', title: r.transcript, text: shortPath(r.transcript, data.home) })];
      if (prompt) {
        children.push(reviewButton(reviewCopyResults.get(r.sessionId) || 'Copy prompt', `copy:${r.sessionId}`, null, () => copyReviewPrompt(r.sessionId, prompt)));
      }
      source = el('div', { class: 'review-source' }, children);
    }
    return el('li', { class: 'review' }, [head, ...(source ? [source] : []), ...reviewBody(r)]);
  });
  list.replaceChildren(...items);
  if (focusKey) [...list.querySelectorAll('[data-review-focus]')].find((n) => n.dataset.reviewFocus === focusKey)?.focus();

  document.getElementById('reviewsNote').textContent =
    `${data.reviews.length} in the last ${REVIEW_DAYS} days · ${countWithOpen(data.reviews)} with open suggestions`;
}

// Warn once either window reaches 75%, on every range. Within a window the percent
// only rises, and readLimits() drops a window past its reset, so a stale cache
// understates usage and never raises a false warning. The rounded percent is
// compared so the banner agrees with the "N% used" the panel shows.
function renderLimitsBanner(limits) {
  bannerGuard.draw(limits, () => drawLimitsBanner(limits));
}

function drawLimitsBanner(limits) {
  const banner = document.getElementById('limitsBanner');
  const high = (limits ? limits.limits : []).filter((l) => Math.round(l.percent) >= LIMIT_WARN_PERCENT);
  // dailyWarning (public/hud.js) compares today's share with the rolling budget.
  const dayHigh = dailyWarning(limits ? limits.today : null);
  banner.hidden = !high.length && !dayHigh;
  banner.replaceChildren(
    el('strong', { text: high.length ? 'Nearing your plan limit' : "Nearing today's budget" }),
    ...high.map((l) => el('div', {
      text: `${l.label}: ${Math.round(l.percent)}% used${l.resetsAt == null ? '' : ` · ${formatReset(l.resetsAt)}`}`,
    })),
    ...(dayHigh ? [el('div', {
      text: `Today: ${dayHigh.share}% of the week, ${dayHigh.rolling ? 'rolling budget' : 'budget'} ${dayHigh.budget}%`,
    })] : [])
  );
}

// The Record day card's all-time value. Fetched once on load and once on
// Refresh, not on the 5s live poll or a range switch: /api/records reads the all-time
// and 7-day aggregates, so polling it on every tick would buy nothing. A failure,
// including a 500 whose body is { error }, resolves to null. Optional, like requestSessions.
function requestRecords() {
  return getJson('/api/records', { optional: true });
}

// Kept so /api/records resolving after the first render can redraw the card
// with the same daily data the last summary produced.
let lastRecordDaily = null;
let lastSummary = null;
let recordsData = null;
// The local date the last /api/records request was made on. recentDays holds the
// 6 days before that date, so after midnight it is missing yesterday.
let recordsDay = null;
// The local date recordsData was fetched for. renderWeekTotals ignores recentDays
// from an earlier date, because rollingWeek would sum the wrong 6 days.
let recordsDataDay = null;
// Numbers each /api/records request, so a slow first load cannot overwrite a
// later Refresh.
const recordsLoads = createSequence();

// renderWeekTotals calls this on Today whenever recordsDay is not today's date.
// The early return below leaves recordsDay unset on purpose: while every consumer
// of /api/records is hidden nothing is fetched, and the next renderWeekTotals
// after one shows again tries once more.
function refreshRecords() {
  if (!neededRequests(state.hiddenKeys, state.currentDays).has('records')) return;
  const day = localDateStr(new Date());
  recordsDay = day;
  const isLatest = recordsLoads.next();
  requestRecords().then((data) => {
    if (!isLatest()) return;
    // A failed request keeps the last good records, so the card keeps its value.
    if (data) {
      recordsData = data;
      recordsDataDay = day;
    }
    if (lastRecordDaily && shown('card-record')) renderRecord(lastRecordDaily);
    if (lastSummary) renderWeekTotals(lastSummary);
  });
}

// On Today, a second line under Total cost and Total tokens with the rolling
// 7 days: today's live totals plus the 6 days before it from /api/records.
// It shows a dash until /api/records has answered, which takes a few seconds
// on the first request after the server starts, while the row store reads the
// transcripts. Empty on every other range.
function renderWeekTotals(summary) {
  lastSummary = summary;
  // A page left open on Today past midnight refetches once, on the first poll of
  // the new day. Refresh is hidden on Today, so nothing else would refetch.
  if (state.currentDays === 'today' && recordsDay !== localDateStr(new Date())) refreshRecords();
  const today = state.currentDays === 'today';
  const recentDays = recordsDataDay === localDateStr(new Date()) ? recordsData?.recentDays ?? null : null;
  const week = today
    ? rollingWeek(recentDays, localDateStr(new Date()), { cost: summary.totalCost, tokens: summary.totalTokens })
    : null;
  const title = today ? 'today and the 6 days before it' : '';
  const cost = document.getElementById('cardCostWeek');
  const tokens = document.getElementById('cardTokensWeek');
  const line = (value) => (today ? `7d total: ${week ? value : '—'}` : '');
  cost.textContent = line(week && formatCost(week.cost));
  tokens.textContent = line(week && formatTokens(week.tokens));
  cost.title = title;
  tokens.title = title;
}

// The value and date line show the all-time record: the day with the most tokens,
// with that day's cost. The note shows the record within the range on screen, also
// with its cost. Today's total grows on every live poll, and the range's aggregate can
// be newer than the all-time value that /api/records returns. So today's total or
// the range record replaces the fetched all-time record when it has more tokens.
function renderRecord(daily) {
  lastRecordDaily = daily;

  const todayStr = localDateStr(new Date());
  // busiestDay over today's entries alone is today's total, with its cost.
  const today = busiestDay(daily.filter((d) => d.date.slice(0, 10) === todayStr));
  const rangeRecord = busiestDay(daily);

  let shownAllTime = recordsData && recordsData.allTime;
  if (shownAllTime) {
    if (today && today.tokens > shownAllTime.tokens) shownAllTime = today;
    if (rangeRecord && rangeRecord.tokens > shownAllTime.tokens) shownAllTime = rangeRecord;
  }

  document.getElementById('cardRecord').textContent = shownAllTime ? formatTokens(shownAllTime.tokens) : '—';
  document.getElementById('cardRecordDate').textContent =
    shownAllTime ? `${shortDate(shownAllTime.date)} · ${formatCost(shownAllTime.cost)}` : '';

  // On Today the range record is today itself, and Total tokens already shows
  // that number, so the note stays empty.
  let note = '';
  if (state.currentDays !== 'today' && rangeRecord) {
    note = shownAllTime && rangeRecord.date === shownAllTime.date
      ? 'this range holds the record'
      : `this range: ${formatTokens(rangeRecord.tokens)} · ${formatCost(rangeRecord.cost)} · ${shortDate(rangeRecord.date)}`;
  }
  document.getElementById('cardRecordNote').textContent = note;
}

function renderRtk(rtk) {
  const live = Boolean(rtk && rtk.meta.dbExists);

  const dailyPanel = document.getElementById('rtkDailyPanel');
  const hasDaily = live && rtk.daily.some((d) => d.saved > 0);
  dailyPanel.hidden = !hasDaily;
  if (hasDaily && shown('rtkDaily')) {
    drawBarChart(document.getElementById('rtkDailyChart'), rtk.daily, {
      // Single series, so no legend and no new hue: this borrows the token palette's
      // blue the way the daily-tokens chart borrows cache-read purple.
      color: '#3987e5',
      valueKey: 'saved',
      tooltipFn: (d) =>
        `<b>${fullDate(d.date)}</b><br>${formatTokens(d.saved)} of ${formatTokens(d.input)} filtered out` +
        `<br>${d.input > 0 ? ((d.saved / d.input) * 100).toFixed(1) : '0.0'}% across ${d.commands.toLocaleString('en-US')} commands`,
    });
  }

  const cmdPanel = document.getElementById('rtkCommandPanel');
  const hasCommands = live && rtk.commands.some((c) => c.saved > 0);
  cmdPanel.hidden = !hasCommands;
  if (hasCommands && shown('rtkCommands')) renderRtkCommands(rtk.commands.filter((c) => c.saved > 0));
}

// A table rather than a list, because $/MTok is the number that explains why a
// model's token share and its cost share are different. escapeHtml is used on
// the model name: it comes from a log file, not from this codebase.
function drawModelList(container, models) {
  container.innerHTML = '';
  if (!models.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No model usage in this range.' }));
    return;
  }

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);
  const rows = models
    .map((m) => {
      // An unpriced model's cost is 0 because no rate is known. Showing $0.00,
      // 0.0% or $0.00/MTok would read as a measured value.
      const unpriced = !m.priced;
      const perMillion = m.tokens > 0 ? m.cost / (m.tokens / 1e6) : 0;
      const share = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
      return `<tr>
        <td class="model-name"><span class="swatch" style="${segmentTexture(m.family)}"></span>${escapeHtml(m.model)}</td>
        <td class="num">${formatTokens(m.tokens)}</td>
        <td class="num cost-cell">${unpriced ? 'unpriced' : formatCost(m.cost)}</td>
        <td class="num">${unpriced ? '&mdash;' : share.toFixed(1) + '%'}</td>
        <td class="num">${unpriced ? '&mdash;' : formatCost(perMillion)}</td>
      </tr>`;
    })
    .join('');

  container.innerHTML = `<table class="model-table">
    <thead><tr>
      <th>Model</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Share</th><th class="num">$/MTok</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Prices per million tokens, as the pricing page writes them: "$4 / $20".
function rateText(row) {
  let text = `$${row.input} / $${row.output}`;
  if (row.cacheReadMult != null) text += ` · cache read ${row.cacheReadMult}x`;
  if (row.fast) text += ` · fast $${row.fast.input} / $${row.fast.output}`;
  return text;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// The last applied snapshot's effective date, or null on built-in prices.
// Set from loadPricesSource() and read by renderPricesCheck to floor the
// Apply date picker: the server already refuses a date before this one, so
// the picker should not offer it.
let lastAppliedDate = null;

async function loadPricesSource() {
  if (!neededRequests(state.hiddenKeys, state.currentDays).has('prices')) return;
  const note = document.getElementById('pricesSource');
  // /api/prices answers 200 with an error field when prices.json was ignored.
  // That field is a warning to show, so this request does not use getJson.
  const res = await fetch('/api/prices').catch(() => null);
  const source = res?.ok ? await res.json().catch(() => null) : null;
  if (!source) {
    note.textContent = '';
    return;
  }
  lastAppliedDate = source.kind === 'fetched' ? source.date : null;
  note.textContent = source.kind === 'built-in'
    ? `Prices: built-in, checked ${source.date}`
    : `Prices: from Anthropic's pricing page, effective ${source.date}`;
  if (source.error) note.textContent += ` · prices.json ignored: ${source.error}`;
}

function renderPricesCheck(result) {
  const box = document.getElementById('pricesCheck');
  box.hidden = false;
  box.innerHTML = '';
  if (result.error) {
    box.appendChild(el('p', { class: 'panel-note', text: result.error }));
    return;
  }
  const lines = [
    ...result.added.map((r) => `New: ${r.name} ${rateText(r)}`),
    ...result.changed.map((c) => `Changed: ${c.after.name} ${rateText(c.before)} → ${rateText(c.after)}`),
    ...result.skipped.map((s) => `Skipped: ${s.name} (${s.reason})`),
  ];
  for (const text of lines) box.appendChild(el('p', { class: 'panel-note', text }));
  if (!result.added.length && !result.changed.length) {
    box.appendChild(el('p', { class: 'panel-note', text: `Prices match Anthropic's pricing page (${result.unchanged} models).` }));
    return;
  }
  const today = localDateStr(new Date());
  const date = el('input', {
    type: 'date', id: 'pricesEffective', value: today, max: today,
    ...(lastAppliedDate ? { min: lastAppliedDate } : {}),
  });
  const apply = el('button', { class: 'refresh-btn', type: 'button', text: 'Apply' });
  apply.addEventListener('click', () => applyPrices(date.value));
  box.appendChild(el('div', { class: 'prices-apply' }, [el('label', { for: 'pricesEffective', text: 'Effective from' }), date, apply]));
  box.appendChild(el('p', { class: 'panel-note', text: 'Usage before this date keeps its old prices. New models are priced for all dates.' }));
}

async function applyPrices(effectiveFrom) {
  const result = await postJson('/api/prices/apply', { effectiveFrom })
    .catch((err) => ({ error: `Could not reach the dashboard server: ${err.message}` }));
  const box = document.getElementById('pricesCheck');
  if (result.error) {
    // Keep the diff on screen, so a refused date can be corrected and applied again.
    // Drop any earlier error line first, so retrying a bad date doesn't pile them up.
    box.querySelectorAll('.prices-error').forEach((node) => node.remove());
    box.appendChild(el('p', { class: 'panel-note prices-error', text: result.error }));
    return;
  }
  box.hidden = true;
  loadPricesSource();
  reloadAll();
}

document.getElementById('checkPricesBtn').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const result = await postJson('/api/prices/check')
    .catch((err) => ({ error: `Could not reach the dashboard server: ${err.message}` }));
  btn.disabled = false;
  btn.textContent = 'Check prices';
  renderPricesCheck(result);
});

// #region setup changes

// Days of history the setup charts show for each range picker value. Today and 7d
// show 14 days, since a day or a week holds too few sessions to read a trend.
// null is all history.
function visibleDays() {
  if (state.currentDays === 'all') return null;
  return state.currentDays === 'today' || state.currentDays === 7 ? 14 : state.currentDays;
}

function chartDomain(report) {
  return rangeDomain(timeDomain(report, BA_ROWS.map((row) => row.key)), visibleDays());
}
const tokensCell = (v) => formatTokens(Math.round(v));
// One decimal place: the API-call medians are often a half.
const axisCount = (v) => String(Math.round(v * 10) / 10);
const axisPercent = (x) => `${Math.round(x * 100)}%`;

// Each row of the before/after table, and the daily chart it shows when picked:
// title names the chart, axis formats its y-axis, unit (unitOne when n is 1) follows n in a bar's tooltip.
const BA_ROWS = [
  { name: 'Session start context', key: 'sessionStart', n: 'sessions', unit: 'sessions', unitOne: 'session', fmt: tokensCell, axis: axisTokens, title: 'Median context at session start, tokens per day' },
  { name: 'Bash result, median', key: 'bashMedian', n: 'bashN', unit: 'Bash calls', unitOne: 'Bash call', fmt: tokensCell, axis: axisTokens, title: 'Median Bash result on the main thread, tokens per day' },
  { name: 'Bash result, p90', key: 'bashP90', n: 'bashN', unit: 'Bash calls', unitOne: 'Bash call', fmt: tokensCell, axis: axisTokens, title: '90th percentile Bash result on the main thread, tokens per day' },
  { name: 'Cost per prompt, median', key: 'costPerPrompt', n: 'prompts', unit: 'prompts', unitOne: 'prompt', fmt: formatCost, axis: axisCost, title: 'Median cost per prompt, per day' },
  { name: 'API calls per prompt, median', key: 'callsPerPrompt', n: 'prompts', unit: 'prompts', unitOne: 'prompt', fmt: axisCount, axis: axisCount, title: 'Median API calls per prompt, per day' },
  { name: 'Cache hit rate', key: 'cacheHit', n: 'callN', unit: 'API calls', unitOne: 'API call', fmt: formatPercent, axis: axisPercent, points: true, title: 'Cache hit rate, per day' },
];
const RTK_ROWS = [
  { name: 'Tokens kept per command', key: 'keptPerCommand', n: 'commands', unit: 'commands', unitOne: 'command', fmt: tokensCell, axis: axisTokens, rtk: true, title: 'Tokens rtk kept per command, per day' },
  { name: 'Share of output filtered', key: 'filteredShare', n: 'commands', unit: 'commands', unitOne: 'command', fmt: formatPercent, axis: axisPercent, points: true, rtk: true, title: 'Share of output rtk filtered, per day' },
];

// A share (cache hit, filtered) changes in percentage points; everything else as a
// relative change. Either way, a change under 5% relative to the "before" value is
// shown dimmed with no arrow, per spec: the spike measured day-to-day swings well
// above that on every row. A zero "before" value has no relative change to compute,
// so it falls back to the same dimmed dash as a missing before or after value.
function changeCell(a, b, points) {
  const td = el('td', { class: 'num' });
  if (a == null || b == null || a === 0) {
    td.textContent = '—';
    td.classList.add('dim');
    return td;
  }
  const diff = points ? (b - a) * 100 : ((b - a) / a) * 100;
  const small = Math.abs((b - a) / a) < 0.05;
  td.textContent = `${diff > 0 ? '+' : ''}${Math.round(diff)}${points ? ' pts' : '%'}`;
  td.classList.add(small ? 'dim' : diff < 0 ? 'down' : 'up');
  return td;
}

// The label is a button so a keyboard user can pick the row. A click anywhere on
// the row picks it too.
function baRow(row, before, after, onSelect) {
  const a = before ? before[row.key] : null;
  const b = after ? after[row.key] : null;
  const name = el('td', {}, [el('button', { type: 'button', class: 'ba-row-btn', 'aria-pressed': 'false', text: row.name })]);
  if (row.n) name.appendChild(el('span', { class: 'n', text: `n ${before ? before[row.n] : 0}→${after ? after[row.n] : 0}` }));
  const tr = el('tr', { 'data-key': row.key }, [
    name,
    el('td', { class: 'num', text: a == null ? '—' : row.fmt(a) }),
    el('td', { class: 'num', text: b == null ? '—' : row.fmt(b) }),
    changeCell(a, b, row.points),
  ]);
  tr.addEventListener('click', onSelect);
  return tr;
}

function renderBeforeAfter(report, marker) {
  const table = document.getElementById('beforeAfterTable');
  const note = document.getElementById('overlapNote');
  table.replaceChildren();
  note.textContent = '';
  if (!marker) return;
  const head = el('tr', {}, ['7 days', 'before', 'after', 'change'].map((text, i) => el('th', { text, class: i ? 'num' : '' })));
  const pick = (row) => () => selectRow(report, marker, row.key);
  const body = el('tbody', {}, BA_ROWS.map((row) => baRow(row, marker.before, marker.after, pick(row))));
  if (marker.before.rtk || marker.after.rtk) {
    body.appendChild(el('tr', { class: 'group' }, [el('td', { text: "From rtk's own history", colspan: '4' })]));
    for (const row of RTK_ROWS) body.appendChild(baRow(row, marker.before.rtk, marker.after.rtk, pick(row)));
  }
  table.append(el('thead', {}, [head]), body);

  const near = report.markers.filter((o) => o !== marker && Math.abs(o.t - marker.t) <= WEEK_MS);
  // Claude Code ships about once a day, so its releases get their own line instead
  // of burying the user's own changes in the list.
  const own = near.filter((o) => o.kind !== 'claude-code');
  const releases = near.filter((o) => o.kind === 'claude-code');
  const lines = [
    own.length
      ? `Also in this window: ${own.map((o) => `${markerDate(o.t)} ${o.label}`).join('; ')}`
      : 'No other change in this window.',
  ];
  if (releases.length) {
    lines.push(`Claude Code releases in this window: ${releases.map((o) => o.version).join(', ')}`);
  }
  note.replaceChildren(...lines.flatMap((text, i) => (i ? [el('br'), text] : [text])));
}

const markerKey = (m) => `${m.t}|${m.label}`;
let changesReport = null;
let selectedMarkerKey = null;

// The row whose daily chart shows. Kept across marker changes, redraws and
// refreshes; a page load starts again on the first row.
let selectedRowKey = 'sessionStart';

// The row the chart shows: the selected one, or the first row when the selected
// row is an rtk row and the report has no rtk series. selectedRowKey keeps the rtk
// key, so the rtk row comes back when rtk does.
function chartRow(report) {
  return [...BA_ROWS, ...RTK_ROWS].find((row) => row.key === selectedRowKey && report.daily[row.key]) || BA_ROWS[0];
}

// Moves the selection marks to the picked row and redraws its chart. The table is
// not rebuilt, so keyboard focus stays on the button that was pressed.
function selectRow(report, marker, key) {
  selectedRowKey = key;
  const row = chartRow(report);
  for (const tr of document.querySelectorAll('#beforeAfterTable tr[data-key]')) {
    const on = tr.dataset.key === row.key;
    tr.classList.toggle('selected', on);
    tr.querySelector('.ba-row-btn').setAttribute('aria-pressed', String(on));
  }
  document.getElementById('baChartTitle').textContent = row.title;
  const chart = document.getElementById('baDailyChart');
  chart.setAttribute('aria-label', row.title);
  drawMetricChart(chart, report, marker, row, chartDomain(report));
}

function selectMarker(report, marker) {
  selectedMarkerKey = marker ? markerKey(marker) : null;
  for (const btn of document.querySelectorAll('#markerList .marker-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.key === selectedMarkerKey));
  }
  // A closed day still shows that it holds the selected change.
  const day = marker ? localDateStr(new Date(marker.t)) : null;
  for (const group of document.querySelectorAll('#markerList .marker-day')) {
    group.querySelector('.marker-day-btn').classList.toggle('has-selected', group.dataset.day === day);
  }
  renderBeforeAfter(report, marker);
  selectRow(report, marker, selectedRowKey);
}

function renderChangesFileNote(file) {
  const note = document.getElementById('changesFileNote');
  note.hidden = false;
  note.classList.toggle('changes-error', file.status === 'error');
  if (file.status === 'error') note.textContent = `Couldn't read all of ${file.path}: ${file.error}`;
  else if (file.status === 'missing') note.textContent = `Add other changes to ${file.path} (format in the README).`;
  else note.hidden = true;
}

// Changes grouped by local day, in report order. One day often holds many
// changes (17 on 9/28), and a flat list of every change pushed the comparison
// off screen. A day only opens and closes; the changes inside pick the comparison,
// because each change's before/after window is measured from its own time.
function groupMarkersByDay(markers) {
  const days = new Map();
  for (const m of markers) {
    const day = localDateStr(new Date(m.t));
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(m);
  }
  return [...days].map(([day, items]) => ({ day, items }));
}

function markerDayGroup(report, { day, items }, open) {
  const listId = `markerDay-${day}`;
  const kinds = [...new Set(items.map((m) => m.kind))];
  const toggle = el('button', { type: 'button', class: 'marker-day-btn', 'aria-controls': listId });
  toggle.append(...kinds.map((k) => markerIcon(k)), `${shortDate(day)} · ${items.length} change${items.length > 1 ? 's' : ''}`);
  const list = el('div', { class: 'marker-day-items', id: listId });
  for (const m of items) {
    const btn = el('button', { type: 'button', class: 'marker-btn', 'data-key': markerKey(m), 'aria-pressed': 'false' });
    btn.append(markerIcon(m.kind), m.label);
    btn.addEventListener('click', () => selectMarker(report, m));
    list.appendChild(btn);
  }
  const group = el('div', { class: 'marker-day', 'data-day': day }, [toggle, list]);
  const setOpen = (isOpen) => {
    list.hidden = !isOpen;
    toggle.setAttribute('aria-expanded', String(isOpen));
    group.classList.toggle('open', isOpen);
  };
  toggle.addEventListener('click', () => setOpen(list.hidden));
  setOpen(open);
  return group;
}

function renderChanges(report) {
  changesReport = report;
  document.getElementById('sessionStartPanel').hidden = false;
  document.getElementById('beforeAfterPanel').hidden = false;
  renderChangesFileNote(report.changesFile);
  if (shown('sessionStart')) drawSessionStartChart(document.getElementById('sessionStartChart'), document.getElementById('sessionStartLegend'), report, chartDomain(report));
  // The marker list, the Bash chart and the table all belong to the before/after panel.
  // Showing the panel again re-runs renderChanges through showKeys (via redrawCharts or loadChanges).
  if (!shown('beforeAfter')) return;

  const list = document.getElementById('markerList');
  list.replaceChildren();
  if (!report.markers.length) {
    list.appendChild(el('p', { class: 'panel-note', text: 'No changes to compare yet.' }));
    selectMarker(report, null);
    return;
  }
  const selected = report.markers.find((m) => markerKey(m) === selectedMarkerKey)
    || report.markers[report.markers.length - 1];
  const selectedDay = localDateStr(new Date(selected.t));
  for (const group of groupMarkersByDay(report.markers)) {
    list.appendChild(markerDayGroup(report, group, group.day === selectedDay));
  }
  selectMarker(report, selected);
}

const CHANGES_CHARTS = ['sessionStartChart', 'baDailyChart'];

// /api/changes reads the all-history scan, about 2.4s when that cache entry is
// cold. Both panels show straight away with a placeholder, so the page does not
// jump when the data arrives. The chart draw functions clear their container, so
// the placeholder needs no explicit removal on success.
function showChangesLoading() {
  // A load in progress has no report yet: without this, a failed reload's catch
  // block would leave the previous report in place, and a later redraw (e.g. a
  // row expand) would show stale data instead of the error state it just set.
  changesReport = null;
  document.getElementById('sessionStartPanel').hidden = false;
  document.getElementById('beforeAfterPanel').hidden = false;
  for (const id of CHANGES_CHARTS) {
    document.getElementById(id).replaceChildren(
      el('div', { class: 'chart-loading' }, [spinnerNode(), document.createTextNode('Loading setup changes…')])
    );
  }
}

// Numbers each /api/changes request, like recordsLoads.
const changesLoads = createSequence();

// The fetch does not depend on the range picker, so it loads once and again on
// Refresh. A range change only redraws from the loaded report. A response that is
// not from the newest request is dropped, whether it succeeded or failed, because
// the newest request draws both panels when it settles.
async function loadChanges() {
  if (!neededRequests(state.hiddenKeys, state.currentDays).has('changes')) return;
  const isLatest = changesLoads.next();
  showChangesLoading();
  const report = await getJson('/api/changes');
  if (!isLatest()) return;
  try {
    if (report.error) throw new Error(report.error);
    renderChanges(report);
  } catch (err) {
    // A spinner that never stops reads as still loading, so it goes, and the
    // before/after panel has nothing to show without a report.
    for (const id of CHANGES_CHARTS) document.getElementById(id).replaceChildren();
    document.getElementById('beforeAfterPanel').hidden = true;
    document.getElementById('sessionStartPanel').hidden = false;
    const note = document.getElementById('changesFileNote');
    note.hidden = false;
    note.classList.add('changes-error');
    note.textContent = `Couldn't load setup changes: ${err.message}`;
  }
}

// #endregion

// #region panel light

// Lights the border of the panel under the pointer in cyan, near the pointer (see
// .panel::before in style.css). One pointermove listener on #app serves every
// panel, throttled to one update per frame. It runs only for a pointer that can
// hover and when reduced motion is off. The header cards are not .panel, so they
// never light.
function setupPanelLight() {
  if (!matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) return;
  const app = document.getElementById('app');
  let lit = null;
  let frame = 0;
  let last = null;
  app.addEventListener('pointermove', (e) => {
    last = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!last) return;
      const panel = last.target.closest ? last.target.closest('#app .panel') : null;
      if (panel !== lit) {
        if (lit) lit.classList.remove('lit');
        lit = panel;
        if (lit) lit.classList.add('lit');
      }
      if (!lit) return;
      const box = lit.getBoundingClientRect();
      lit.style.setProperty('--x', `${last.clientX - box.left}px`);
      lit.style.setProperty('--y', `${last.clientY - box.top}px`);
    });
  });
  app.addEventListener('pointerleave', () => {
    // A fast exit can land pointermove and pointerleave in one frame. Cancelling
    // the pending frame stops it from lighting the panel again after the leave.
    cancelAnimationFrame(frame);
    frame = 0;
    last = null;
    if (lit) lit.classList.remove('lit');
    lit = null;
  });
}

// #endregion

// #region row order

// Each row of panels (a full-width panel or a .panel-row pair) can be moved. The
// order is kept in localStorage as a list of row keys, so the page reopens as it
// was left. A row's key is its first heading's text, stored in data-row-key before
// any control is added to the heading. The collapsed-rows code reads the same key.
// Storage can throw (a private window, blocked site data), and then the page keeps
// the order in index.html.
const ROW_ORDER_KEY = 'cc-dashboard:row-order';

function assignRowKeys() {
  for (const row of document.querySelectorAll('#app > .panel-row, #app > .panel')) {
    const heading = row.querySelector('.panel-head h2');
    if (heading) row.dataset.rowKey = heading.textContent;
  }
}

function panelRows() {
  return [...document.querySelectorAll('#app > .panel-row[data-row-key], #app > .panel[data-row-key]')];
}

function currentRowKeys() {
  return panelRows().map((row) => row.dataset.rowKey);
}

function loadRowOrder() {
  try {
    return JSON.parse(localStorage.getItem(ROW_ORDER_KEY));
  } catch {
    return null;
  }
}

function saveRowOrder(keys) {
  try {
    if (keys) localStorage.setItem(ROW_ORDER_KEY, JSON.stringify(keys));
    else localStorage.removeItem(ROW_ORDER_KEY);
  } catch {
    // Not saved. The rows keep their new order for this page view.
  }
}

// Re-appends the rows to #app in the order of keys. The banners and #mainCards
// come before every row in index.html, so they stay first.
function applyRowOrder(keys) {
  const app = document.getElementById('app');
  const byKey = new Map(panelRows().map((row) => [row.dataset.rowKey, row]));
  for (const key of keys) app.appendChild(byKey.get(key));
}

function clearDropMarks(row) {
  row.classList.remove('drop-before', 'drop-after');
}

// Adds a handle to each row's first heading. Pressing the handle makes that row
// draggable, so a drag that starts anywhere else in the row selects text as
// before. The row under the pointer marks the drop point as a line on its top or
// bottom edge, whichever half the pointer is in. onDrop runs after each move.
// The handle's glyph is CSS content, so the heading's textContent is unchanged.
function setupRowDrag(onDrop) {
  let dragged = null;
  for (const row of panelRows()) {
    const handle = el('span', { class: 'row-handle', title: 'Drag to move', 'aria-hidden': 'true' });
    // A release anywhere clears draggable. Some browsers send a release off the
    // handle to the element under the pointer, so the handle's own listener would miss it.
    // A cancelled pointer (a touch the browser takes over for scrolling, say) sends
    // pointercancel and no pointerup, so either event clears it, and the one
    // AbortController removes both listeners together.
    handle.addEventListener('pointerdown', () => {
      row.draggable = true;
      const release = new AbortController();
      const end = () => {
        row.draggable = false;
        release.abort();
      };
      document.addEventListener('pointerup', end, { signal: release.signal });
      document.addEventListener('pointercancel', end, { signal: release.signal });
    });
    row.querySelector('.panel-head h2').prepend(handle);

    // A drag of selected text, a link or an image inside the row targets that
    // element, not the row, so only a drag from the handle moves the row.
    row.addEventListener('dragstart', (e) => {
      if (e.target !== row) return;
      dragged = row;
      row.classList.add('row-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.rowKey);
    });
    // A drag that did not start from a handle, such as a file from the desktop,
    // leaves dragged null, so no row accepts the drop.
    row.addEventListener('dragover', (e) => {
      if (!dragged || dragged === row) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget)) clearDropMarks(row);
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = row.classList.contains('drop-after');
      clearDropMarks(row);
      row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
      onDrop();
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('row-dragging');
      dragged = null;
    });
  }
}

// Runs before setupCollapsibleRows, which reads data-row-key.
function setupRowOrder() {
  assignRowKeys();
  const defaultKeys = currentRowKeys();
  const saved = loadRowOrder();
  applyRowOrder(orderRowKeys(defaultKeys, saved));

  const resetBtn = document.getElementById('resetLayoutBtn');
  resetBtn.hidden = saved == null;
  resetBtn.addEventListener('click', () => {
    applyRowOrder(defaultKeys);
    saveRowOrder(null);
    resetBtn.hidden = true;
  });

  setupRowDrag(() => {
    saveRowOrder(currentRowKeys());
    resetBtn.hidden = false;
  });
}

// #endregion

// #region collapsible rows

// Each visual row of panels collapses to its headings. A two-panel row collapses
// as one, and a full-width panel is a row of its own. Collapsed rows are kept in
// localStorage, keyed by data-row-key (see the row order region), so the page
// reopens as it was left. Storage can throw (a private window, blocked site data),
// and then every row starts expanded.
const COLLAPSED_ROWS_KEY = 'cc-dashboard:collapsed-rows';

function loadCollapsedRows() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_ROWS_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveCollapsedRows(keys) {
  try {
    localStorage.setItem(COLLAPSED_ROWS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved. The row still toggles for this page view.
  }
}

function setupCollapsibleRows() {
  const collapsed = loadCollapsedRows();
  for (const row of document.querySelectorAll('#app > .panel-row, #app > .panel')) {
    const headings = [...row.querySelectorAll('.panel-head h2')];
    if (!headings.length) continue;
    const key = row.dataset.rowKey;
    const names = headings.map((h) => h.textContent).join(' and ');
    const toggle = el('button', { type: 'button', class: 'row-toggle' });
    const setCollapsed = (isCollapsed) => {
      row.classList.toggle('row-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${names}`);
    };
    toggle.addEventListener('click', () => {
      const isCollapsed = !row.classList.contains('row-collapsed');
      setCollapsed(isCollapsed);
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsedRows(collapsed);
      // A chart drawn while hidden has the 200px fallback width, so an expand
      // needs a redraw. redrawCharts draws the payload charts from lastPayload;
      // the changes charts are redrawn only when this row holds them.
      if (!isCollapsed) redrawCharts({ changes: row.id === 'sessionStartPanel' || row.id === 'beforeAfterPanel' });
    });
    headings[0].prepend(toggle);
    setCollapsed(collapsed.has(key));
  }
}

// The Skills and Subagents lists in Where usage goes each collapse to their title.
// They start collapsed from the markup on every load, and the state is not saved.
// The toggles sit outside #skillBars and #subagentBars, which drawHBars
// rebuilds on every render, so a re-render leaves an open list open.
function setupUsageGroupToggles() {
  for (const toggle of document.querySelectorAll('#attributionPanel .group-toggle')) {
    const group = toggle.closest('.usage-group');
    toggle.addEventListener('click', () => {
      const isCollapsed = !group.classList.contains('group-collapsed');
      group.classList.toggle('group-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${toggle.dataset.name}`);
    });
  }
}

// #endregion

// #region hidden panels

// Any panel or summary card can be hidden with its "x" button and shown again
// from the ☰ menu in the header. The hidden keys (data-hide-key in index.html)
// are kept in localStorage. A hidden element gets data-user-hidden, which
// style.css hides with !important, so a renderer setting `panel.hidden = false`
// cannot show it. Storage can throw (a private window, blocked site data), and
// then nothing starts hidden.
const HIDDEN_KEY = 'cc-dashboard:hidden';

function loadHidden() {
  try {
    return new Set(parseHidden(localStorage.getItem(HIDDEN_KEY)));
  } catch {
    return new Set();
  }
}

function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hiddenKeys]));
  } catch {
    // Not saved. The change holds for this page view.
  }
}

state.hiddenKeys = loadHidden();

// The name in the menu and in the "x" button's label: the panel's heading or the
// card's label. The row handle and toggle in a heading add no text.
function hideName(element) {
  const label = element.querySelector('.panel-head h2, .card-label');
  return label ? label.textContent.trim() : element.dataset.hideKey;
}

// setupRowDrag and setupCollapsibleRows put a row's handle and toggle in its first
// heading. When the first panel of a pair is hidden, they move to the heading of
// the panel still showing, and back when the first panel returns.
function placeRowControls(row, panel) {
  const heading = panel.querySelector(':scope > .panel-head > h2');
  const toggle = row.querySelector(':scope > .panel > .panel-head > h2 > .row-toggle');
  const handle = row.querySelector(':scope > .panel > .panel-head > h2 > .row-handle');
  if (heading && toggle && toggle.parentElement !== heading) heading.prepend(...[toggle, handle].filter(Boolean));
}

function applyHidden() {
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    element.toggleAttribute('data-user-hidden', state.hiddenKeys.has(element.dataset.hideKey));
  }
  for (const row of document.querySelectorAll('#app > .panel-row')) {
    const panels = [...row.querySelectorAll(':scope > .panel')];
    const visible = panels.filter((panel) => !panel.hasAttribute('data-user-hidden'));
    row.toggleAttribute('data-user-hidden', visible.length === 0);
    placeRowControls(row, visible[0] || panels[0]);
  }
  renderHiddenMenu();
}

function hideKey(key) {
  state.hiddenKeys.add(key);
  saveHidden();
  applyHidden();
  const element = document.querySelector(`[data-hide-key="${key}"]`);
  // The other panel of a pair widens to the full row, so its SVG needs a redraw at the new width.
  if (element && element.closest('.panel-row')) redrawCharts({ changes: false });
}

// A hidden panel was not drawn, so showing one redraws the page. A request that
// was skipped because all its panels were hidden runs again here. rtk, sessions
// and reviews come from fetchAll, and lastPayload holds null for a skipped one, so
// when one of those three resumes, redrawCharts loads the page again.
function showKeys(keys) {
  const before = neededRequests(state.hiddenKeys, state.currentDays);
  for (const key of keys) state.hiddenKeys.delete(key);
  saveHidden();
  applyHidden();
  const after = neededRequests(state.hiddenKeys, state.currentDays);
  const resumed = (request) => after.has(request) && !before.has(request);
  if (resumed('records')) refreshRecords();
  if (resumed('prices')) loadPricesSource();
  // loadChanges renders both changes panels itself when it finishes.
  if (resumed('changes')) loadChanges();
  redrawCharts({ changes: !resumed('changes'), refetch: ['rtk', 'sessions', 'reviews'].some(resumed) });
}

// One button per hidden element, in page order, then Show all when two or more
// are hidden. Choosing one closes the menu, and the popover returns focus to ☰.
function renderHiddenMenu() {
  const menu = document.getElementById('hiddenMenu');
  const hidden = [...document.querySelectorAll('[data-hide-key][data-user-hidden]')];
  menu.replaceChildren();
  if (!hidden.length) {
    menu.appendChild(el('p', { class: 'hidden-menu-empty', text: 'Nothing hidden' }));
    return;
  }
  const choose = (keys) => {
    menu.hidePopover();
    showKeys(keys);
  };
  for (const element of hidden) {
    const name = hideName(element) + (element.classList.contains('card') ? ' · card' : '');
    const item = el('button', { type: 'button', class: 'hidden-menu-item', text: name });
    item.addEventListener('click', () => choose([element.dataset.hideKey]));
    menu.appendChild(item);
  }
  if (hidden.length >= 2) {
    const all = el('button', { type: 'button', class: 'hidden-menu-item hidden-menu-all', text: 'Show all' });
    all.addEventListener('click', () => choose(hidden.map((element) => element.dataset.hideKey)));
    menu.appendChild(all);
  }
}

// Adds the "x" to each panel's head and each card, and places the menu under ☰
// each time it opens. Hiding moves focus to ☰, because the focused "x" has just
// disappeared with its panel.
function setupHiding() {
  const menuBtn = document.getElementById('hiddenMenuBtn');
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    const name = hideName(element);
    const btn = el('button', { type: 'button', class: 'hide-btn', 'aria-label': `Hide ${name}`, title: `Hide ${name}`, text: '×' });
    btn.addEventListener('click', () => {
      hideKey(element.dataset.hideKey);
      menuBtn.focus();
    });
    (element.querySelector(':scope > .panel-head') || element).appendChild(btn);
  }
  const menu = document.getElementById('hiddenMenu');
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const box = menuBtn.getBoundingClientRect();
    menu.style.top = `${box.bottom + 6}px`;
    menu.style.right = `${document.documentElement.clientWidth - box.right}px`;
  });
  applyHidden();
}

// #endregion

// #region app state + rendering

const LIVE_POLL_MS = 5000;
// While live, runLoad runs LIVE_POLL_MS after the previous run finished
// (createPoller in public/poll.js), so a slow scan delays the next poll instead of
// overlapping it.
const livePoller = createPoller(() => runLoad(), LIVE_POLL_MS);
// Signature of the last rendered payload. A 5s poll that redraws unconditionally
// would tear down the SVG under the cursor and kill any open tooltip, so an
// unchanged payload skips rendering entirely.
let lastSignature = null;
// Numbers each fetchAll (see createSequence). A 30d request issued before a
// Today click lands after it, and is dropped.
const loads = createSequence();
// The newest payload fetchAll returned. redrawCharts draws from it after a resize,
// a hide or an expand, so a change of width makes no request. The range picker
// sets it to null, because renderPayload reads state.currentDays and would draw the old
// range's buckets with the new range's rules.
let lastPayload = null;

// Time of the last successful summary load, shown as Sync in the status strip.
let lastLoadedAt = null;

// Fills the status strip under the title. loadAndRender calls it on every
// successful summary load, before renderPayload's unchanged-payload check, so Sync
// moves on a quiet poll too. While live, the ring pulses once per call.
function renderStatusStrip(summary) {
  const active = document.querySelector('#rangePicker button.active');
  const status = formatStatus({
    loadedAt: lastLoadedAt,
    range: active ? active.textContent : '',
    sessions: summary.sessions,
    apiCalls: summary.apiCalls,
  });
  document.getElementById('stripSync').textContent = status.sync;
  document.getElementById('stripRange').textContent = status.range;
  document.getElementById('stripSessions').textContent = status.sessions;
  document.getElementById('stripCalls').textContent = status.apiCalls;
  if (!livePoller.running) return;
  const ring = document.querySelector('#liveDot .live-ring');
  ring.classList.remove('ping');
  void ring.offsetWidth; // restarts the animation on the next add
  ring.classList.add('ping');
}

// A range switch, Refresh or first load can take seconds (a cold 30d scan takes
// ~1.9s, All longer), and the previous range's numbers stay on screen meanwhile.
// Those loads mark the page busy, but only after 250ms, so a ~0.17s Today load
// never flashes a spinner. The status element stays in the DOM so screen readers
// track it as a live region.
const BUSY_DELAY_MS = 250;
let busyTimer = null;

function setBusy(on) {
  clearTimeout(busyTimer);
  busyTimer = null;
  const main = document.getElementById('app');
  const status = document.getElementById('loadStatus');
  if (!on) {
    main.removeAttribute('aria-busy');
    status.replaceChildren();
    return;
  }
  busyTimer = setTimeout(() => {
    main.setAttribute('aria-busy', 'true');
    status.replaceChildren(spinnerNode(), document.createTextNode('Loading…'));
  }, BUSY_DELAY_MS);
}

function setLive(on) {
  if (on) livePoller.start();
  else livePoller.stop();
  document.getElementById('liveDot').classList.toggle('is-off', !on);
  document.querySelector('#liveDot .live-text').textContent = on ? 'Link live' : 'Paused';
  // A live range re-scans every 5 seconds, so a manual refresh has nothing to do.
  document.getElementById('refreshBtn').hidden = on;
}

// On Today the summary cards sit in the sticky header in a compact form, so they
// stay in view while scrolling. Other ranges show them as full cards in the page.
// The one #summaryCards element moves between the two slots, so every card id
// stays unique and renderPayload fills it the same way wherever it is.
function placeSummaryCards() {
  const cards = document.getElementById('summaryCards');
  const today = state.currentDays === 'today';
  document.getElementById(today ? 'headerCards' : 'mainCards').appendChild(cards);
  cards.classList.toggle('cards-compact', today);
  // Hidden off Today, so the empty slot cannot wrap onto a line of its own.
  document.getElementById('headerCards').hidden = !today;
  // renderPayload hides these two on Today too, but only once the load finishes.
  // Hiding them here keeps the old range's values out of the header meanwhile.
  if (today) {
    document.getElementById('burnCard').hidden = true;
    document.getElementById('projectionCard').hidden = true;
  }
}

// Issues the five requests and waits for all of them. Returns { data, rtk, limits,
// sessions, reviews }, or null when a newer load started while this one waited.
async function fetchAll({ busy = false } = {}) {
  const isLatest = loads.next();

  // Only user-started loads show the busy state. Whichever request is newest
  // clears it when it settles, even a quiet poll, because an older busy request's
  // response is dropped below and would never clear it.
  if (busy) setBusy(true);

  // Every request is issued before any is awaited, so the summary never
  // waits on the others. None of the promises rejects (getJson never does). rtk and limits
  // are optional and resolve to null on failure, so an absent or unreadable source
  // hides its panel. A failed summary resolves to an error payload, which
  // renderPayload turns into the error banner after limits have rendered.
  const summaryRequest = getJson(`/api/summary?days=${state.currentDays}`);
  // A request whose every panel is hidden is skipped (see neededRequests in
  // visibility.js), and its panels render from null, as on a failed request.
  const needed = neededRequests(state.hiddenKeys, state.currentDays);
  const rtkRequest = needed.has('rtk')
    ? getJson(`/api/rtk?days=${state.currentDays}`, { optional: true })
    : Promise.resolve(null);

  const limitsRequest = requestLimits();
  // Only Today shows the sessions panels, so other ranges skip the request and
  // its Today scan.
  const sessionsRequest = needed.has('sessions') ? requestSessions() : Promise.resolve(null);
  const reviewMutationsAtStart = reviewMutations;
  const reviewsRequest = needed.has('reviews') ? requestReviews() : Promise.resolve(null);

  const [data, rtk, limits, sessions, reviews] = await Promise.all([summaryRequest, rtkRequest, limitsRequest, sessionsRequest, reviewsRequest]);
  if (!isLatest()) return null; // a newer request superseded this response
  setBusy(false);
  if (!data.error) lastLoadedAt = Date.now();
  // A dismiss or undo during the request makes its reviews older than the page.
  // The payload then carries lastReviews, the reviews on screen, which the action
  // changed in place, so this load cannot put a dismissed suggestion back. The
  // next poll shows the saved state.
  const reviewsNow = reviewMutations === reviewMutationsAtStart ? reviews : lastReviews;
  lastPayload = { data, rtk, limits, sessions, reviews: reviewsNow };
  return lastPayload;
}

// Draws a payload from fetchAll. lastSignature is set on the last line, after every
// renderer has run. A renderer that throws therefore leaves the previous signature,
// and reportDrawError clears that one. The four panel guards keep no key for a
// draw that threw, so those panels need no clearing.
function renderPayload({ data, rtk, limits, sessions, reviews }) {
  const banner = document.getElementById('statusBanner');

  // Plan usage describes right now: its "stale" suffix and its reset wording
  // (today vs. a dated form) depend on the clock, not on the fetched numbers, so
  // this has to run on every settled response. That includes one whose summary
  // failed, and one the signature below would otherwise treat as unchanged.
  // These three panels show on Today only. Their renderers set that, but a hidden
  // panel's renderer is skipped, so the range rule is applied here too.
  if (state.currentDays !== 'today') {
    for (const id of ['limitsPanel', 'sessionsPanel', 'timelinePanel']) document.getElementById(id).hidden = true;
  }
  if (shown('limits')) renderLimits(limits);
  if (shown('sessions')) renderSessions(sessions);
  if (shown('timeline')) renderTimeline(sessions);
  if (shown('reviews')) renderReviews(reviews);
  renderLimitsBanner(limits);

  if (data.error) {
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${data.error}`;
    lastSignature = null;
    return;
  }

  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models, rtk && rtk.summary]);
  if (signature === lastSignature) return;
  banner.hidden = true;

  if (!data.meta.dirExists) {
    banner.hidden = false;
    banner.innerHTML = `No Claude Code project logs found at <code>${escapeHtml(data.meta.projectsDir)}</code>. Use Claude Code at least once, or set <code>CLAUDE_CONFIG_DIR</code> if you use a custom location.`;
  } else if (data.meta.scannedFiles === 0) {
    banner.hidden = false;
    banner.textContent = 'Found the projects folder, but no session files yet.';
  }

  const s = data.summary;
  if (shown('card-cost')) {
    document.getElementById('cardCost').textContent = formatCost(s.totalCost);
    // The compact header card on Today has room for a short note only, so there
    // the full sentence moves to the note's tooltip.
    const unpricedNote = s.unpricedTokens
      ? `${formatTokens(s.unpricedTokens)} tokens from unrecognized models not priced`
      : '';
    const costNote = document.getElementById('cardCostNote');
    const compact = state.currentDays === 'today';
    costNote.textContent = compact && s.unpricedTokens
      ? `${formatTokens(s.unpricedTokens)} unpriced`
      : unpricedNote;
    costNote.title = compact ? unpricedNote : '';
  }
  if (shown('card-tokens')) document.getElementById('cardTokens').textContent = formatTokens(s.totalTokens);
  renderWeekTotals(s);
  if (shown('card-cache')) document.getElementById('cardCache').textContent = formatPercent(s.cacheEfficiency);

  // Claude Code's own per-session counters, shown as a separate card rather than
  // folded into Total cost. Only present on the all-time range, and only for the
  // sessions that wrote a cost-state line, so it is a floor on what the
  // per-request scan misses, not a replacement total.
  const reportedCard = document.getElementById('reportedCard');
  reportedCard.hidden = s.reportedCost == null;
  if (s.reportedCost != null && shown('card-reported')) {
    document.getElementById('cardReported').textContent = formatCost(s.reportedCost);
    document.getElementById('cardReportedNote').textContent =
      `${s.reportedSessions} of ${s.reportedSessionsOf} sessions`;
  }
  if (shown('card-files')) document.getElementById('cardFiles').textContent = data.meta.scannedFiles;
  if (shown('card-tools')) document.getElementById('cardTools').textContent = s.toolCalls.toLocaleString('en-US');
  if (shown('card-record')) renderRecord(data.daily);

  if (shown('dailyCost')) {
    drawBarChart(document.getElementById('costChart'), data.daily, {
      color: 'var(--accent-cost)',
      valueKey: 'cost',
      tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatCost(d.cost)}`,
    });
  }

  if (shown('dailyTokens')) {
    // The payload carries the four token types per bucket but not their sum, so the
    // total is derived here rather than widening the wire format for one chart.
    const dailyTokens = data.daily.map((d) => ({
      ...d,
      tokens: d.input + d.output + d.cacheCreate + d.cacheRead,
    }));
    drawBarChart(document.getElementById('tokenChart'), dailyTokens, {
      // Cache reads are ~97% of every total, so this borrows their colour rather
      // than adding a sixth hue to a palette validated as a set.
      color: '#9085e9',
      valueKey: 'tokens',
      tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatTokens(d.tokens)} tokens`,
    });
  }

  if (shown('cumulativeCost')) drawCumulativeChart(document.getElementById('cumulativeChart'), data.daily);

  // Hourly buckets on the Today range, where a daily rate has no meaning.
  const perDay = state.currentDays === 'today' ? null : costPerDay(data.daily);
  document.getElementById('burnCard').hidden = perDay == null;
  document.getElementById('projectionCard').hidden = perDay == null;
  if (perDay != null && shown('card-burn')) document.getElementById('cardBurn').textContent = formatCost(perDay);
  if (perDay != null && shown('card-projection')) document.getElementById('cardProjection').textContent = formatCost(perDay * 30);

  if (shown('tokenTypes')) {
    // Reversed so the legend reads in the order the lines actually appear, cache read
    // at the top down to input at the bottom. TOKEN_SERIES is copied, not reversed in
    // place: the stacked charts rely on its order.
    drawTokenLegend(document.getElementById('tokenTypeLegend'), data.daily, [...TOKEN_SERIES].reverse(), true);
    drawLogLineChart(document.getElementById('tokenTypeChart'), data.daily, TOKEN_SERIES);
  }

  if (shown('costByModel')) drawModelList(document.getElementById('modelList'), data.models);

  // Every bar in the panel shares one scale. Groups on separate scales made a
  // 30.8% subagent bar draw longer than a 68.2% thread bar.
  // The two split bars are self-scaling, so only the skill and subagent lists
  // share this one, which is what keeps their lengths comparable to each other.
  const attributionScale = [...data.skills, ...data.subagents].reduce((max, r) => Math.max(max, r.cost), 0);
  const totalCost = data.summary.totalCost;
  // Skill and subagent rows: the bar against the shared scale, the text the true
  // share of total cost.
  const shareOfTotal = (row) => `${(totalCost > 0 ? (row.cost / totalCost) * 100 : 0).toFixed(1)}%`;
  const usageBars = {
    size: (row) => row.cost,
    scaleMax: attributionScale,
    value: shareOfTotal,
    tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${shareOfTotal(row)} of total`,
    empty: 'Nothing attributed in this range.',
  };
  const threadRows = [
    { name: 'Main thread', cost: data.threads.main },
    { name: 'Subagents', cost: data.threads.subagent },
  ];
  const contextRows = [
    { name: `Over ${axisTokens(data.contextThreshold)} context`, cost: data.context.over },
    { name: `Under ${axisTokens(data.contextThreshold)} context`, cost: data.context.under },
  ];
  document.getElementById('attributionPanel').hidden = totalCost <= 0;
  if (shown('attribution')) {
    drawSplitBar(document.getElementById('threadBars'), threadRows);
    drawSplitBar(document.getElementById('contextBars'), contextRows);
    drawHBars(document.getElementById('skillBars'), data.skills.slice(0, 8), usageBars);
    drawHBars(document.getElementById('subagentBars'), data.subagents.slice(0, 8), usageBars);
  }

  if (shown('tools')) renderTools(data.tools || []);

  if (shown('modelMix')) drawModelMix(document.getElementById('modelMixChart'), data.models);

  // An hourly model split is noise, so the over-time view is multi-day only. The mix
  // donut and the Cost by model panel stay on every range, Today included.
  const multiDay = state.currentDays !== 'today';
  document.getElementById('modelDailyPanel').hidden = !multiDay;
  document.getElementById('modelCostDailyPanel').hidden = !multiDay;
  document.getElementById('activityPanel').hidden = !multiDay;
  if (multiDay) {
    if (shown('modelDaily')) drawModelDailyChart(document.getElementById('modelDailyChart'), data.daily, data.models);
    if (shown('modelCostDaily')) drawModelDailyChart(document.getElementById('modelCostDailyChart'), data.daily, data.models, 'cost');
    if (shown('activity')) drawActivityHeatmap(document.getElementById('activityHeatmap'), data.activity);
  }

  renderRtk(rtk);
  lastSignature = signature;
}

async function loadAndRender(options) {
  const payload = await fetchAll(options);
  if (!payload) return;
  // Sync moves on every successful load, a quiet poll included, so the strip is
  // filled before renderPayload's unchanged-payload check.
  if (!payload.data.error) renderStatusStrip(payload.data.summary);
  renderPayload(payload);
}

// A renderer that throws would otherwise reject loadAndRender with nothing to catch
// it, and leave the page half drawn with no message. The banner names the error,
// and clearing lastSignature makes the next poll draw every panel again.
function reportDrawError(err) {
  console.error(err);
  const banner = document.getElementById('statusBanner');
  banner.hidden = false;
  banner.textContent = `Couldn't draw the page: ${err?.message ?? err}`;
  lastSignature = null;
  timelineSignature = null;
}

// Every load goes through runLoad, so no caller leaves a rejection unhandled.
function runLoad(options) {
  return loadAndRender(options).catch(reportDrawError);
}

document.getElementById('rangePicker').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-days]');
  if (!btn) return;
  document.querySelectorAll('#rangePicker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.days;
  state.currentDays = value === 'all' || value === 'today' ? value : Number(value);
  placeSummaryCards();
  lastSignature = null; // the bucket keys change, so force a redraw
  lastPayload = null;
  setLive(state.currentDays === 'today');
  if (changesReport) renderChanges(changesReport);
  runLoad({ busy: true });
});

// Everything the Refresh button re-fetches. Applying prices calls it too, because
// costs are computed in the server's scan and the server has just dropped that scan.
function reloadAll() {
  lastSignature = null;
  refreshRecords();
  runLoad({ busy: true });
  loadChanges();
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  setBusy(true);
  // A rejected refresh (e.g. the server is down) must not skip runLoad in reloadAll:
  // its failed summary request is what clears busy and shows the error banner.
  await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
  reloadAll();
});

// Draws every chart again at the current widths, from lastPayload and with no
// request. It loads instead when there is no payload yet, or when showKeys passes
// refetch because a request skipped at the last load is needed again.
function redrawCharts({ changes = true, refetch = false } = {}) {
  lastSignature = null; // the width changed, so the same data still needs redrawing
  timelineSignature = null;
  if (refetch || !lastPayload) {
    runLoad();
  } else {
    try {
      renderPayload(lastPayload);
    } catch (err) {
      reportDrawError(err);
    }
  }
  if (changes && changesReport) renderChanges(changesReport);
}

// A resize redraws the charts at the new width, 150 ms after the last resize event.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawCharts, 150);
});

setupRowOrder();
setupCollapsibleRows();
setupHiding();
setupPanelLight();
setupUsageGroupToggles();
placeSummaryCards();
setLive(state.currentDays === 'today');
refreshRecords();
runLoad({ busy: true });
loadChanges();
loadPricesSource();

// #endregion
