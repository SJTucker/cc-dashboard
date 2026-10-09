// The Plan usage panel (Today only) and the limits banner (every range).
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { localDateStr } from '../format.mjs';
import { state } from '../state.mjs';
import { createDrawGuard } from '../guards.mjs';
import { LIMIT_WARN_PERCENT } from '../constants.mjs';

// Draw guards for the panel and the banner. redrawCharts leaves them alone,
// because a change of width does not change a table.
const limitsGuard = createDrawGuard();
const bannerGuard = createDrawGuard();

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
export function requestLimits() {
  return getJson('/api/limits', { optional: true });
}

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

export function renderLimits(limits) {
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

// Warn once either window reaches LIMIT_WARN_PERCENT, on every range. Within a window the percent
// only rises, and readLimits() drops a window past its reset, so a stale cache
// understates usage and never raises a false warning. The rounded percent is
// compared so the banner agrees with the "N% used" the panel shows.
export function renderLimitsBanner(limits) {
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
