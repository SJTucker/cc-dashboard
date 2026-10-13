'use strict';

// Loaded two ways: index.html loads it as a script before main.mjs, which makes these
// functions globals, and the tests load it with require().

// Draw every how-many-th x-axis label. Labels stay at least minGap pixels apart,
// and a chart never shows more than 12. "00:00" in the axis font is about 30px
// wide, so 44px leaves a visible space between neighbouring labels.
function labelStep(count, plotWidth, minGap = 44) {
  const fit = Math.max(1, Math.min(12, Math.floor(plotWidth / minGap)));
  return Math.max(1, Math.ceil(count / fit));
}

// Where each of n bars sits in a plot plotWidth px wide. Every bar gets an equal
// step of plotWidth / n, so the last bar's right edge stays inside the plot for any
// n. The gap between bars is 3px, or a quarter of the step when the step is under
// 12px, so a narrow bar keeps three quarters of its slot. There is no minimum bar
// width: 2000 buckets on 554px give bars 0.21px wide. The chart textures are SVG
// patterns in user space (appendPatternDefs in public/charts/palette.mjs), so the pattern lines up
// from one thin bar to the next and still reads across a run of bars. x(i) is the
// left edge of bar i, measured from the plot's left edge.
function barSlots(n, plotWidth) {
  const step = plotWidth / Math.max(n, 1);
  const gap = Math.min(3, step * 0.25);
  return { step, barWidth: step - gap, x: (i) => i * step + gap / 2 };
}

// The top of a y axis and the step between its gridlines. The step is 1, 2 or 5
// x 10^n, sized so about `ticks` gridlines fit, and the top is rawMax rounded up to
// a whole step, so every gridline reads as a round number. A rawMax that is not a
// positive finite number is treated as 1. Without that, a range whose values are
// all 0 gives a top of 0, and every chart that divides by the top draws NaN.
function axisScale(rawMax, ticks = 4) {
  const top = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 1;
  const rough = top / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const n = rough / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  return { step, max: Math.ceil(top / step) * step };
}

// Where to put a tooltip of width x height for a pointer at (x, y) in a viewport of
// viewWidth x viewHeight. The tooltip sits 14px below and right of the pointer. It
// moves to the left of the pointer when it would cross the right edge, and above the
// pointer when it would cross the bottom edge. It never starts off the left or top
// edge.
function tooltipPosition(x, y, width, height, viewWidth, viewHeight) {
  const GAP = 14;
  let left = x + GAP;
  let top = y + GAP;
  if (left + width > viewWidth) left = x - GAP - width;
  if (top + height > viewHeight) top = y - GAP - height;
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

// The Models share bar's entries for one measure, 'tokens' or 'cost', largest first.
// Each entry is a copy of the model with value set to m[measure]. In the cost view an
// unpriced model's cost is 0 because no rate is known, not because it cost nothing,
// so it goes in unpriced instead of getting a 0% slice.
function mixEntries(models, measure) {
  const unpriced = measure === 'cost' ? models.filter((m) => !m.priced) : [];
  const shown = models
    .filter((m) => !unpriced.includes(m))
    .map((m) => ({ ...m, value: m[measure] }))
    .sort((a, b) => b.value - a.value);
  const total = shown.reduce((sum, m) => sum + m.value, 0);
  return { shown, unpriced, total };
}

// Hour boundaries in local time for the Session timeline's x axis, from start
// rounded down to the hour to end rounded up to the hour. There are always at
// least two, so the axis has a width when start and end share an hour.
function hourTicks(start, end) {
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  const ticks = [d.getTime()];
  while (ticks[ticks.length - 1] < end) {
    d.setHours(d.getHours() + 1);
    ticks.push(d.getTime());
  }
  if (ticks.length < 2) {
    d.setHours(d.getHours() + 1);
    ticks.push(d.getTime());
  }
  return ticks;
}

// Each listed session's parent lane: the session a /clear ended to start it
// (clearedFrom), skipping a cleared session that has no span today. A session whose
// link leads to no listed session with a span has no parent. A loop is cut where it
// is found, so every session still gets a lane.
function clearParents(sessions, shown) {
  const byId = new Map(sessions.filter((s) => typeof s.sessionId === 'string').map((s) => [s.sessionId, s]));
  const parent = new Map();
  for (const s of shown) {
    const seen = new Set([s]);
    for (let p = byId.get(s.clearedFrom); p && !seen.has(p); p = byId.get(p.clearedFrom)) {
      if (p.spans.length) {
        parent.set(s, p);
        break;
      }
      seen.add(p);
    }
  }
  for (const s of shown) {
    const seen = new Set([s]);
    for (let p = parent.get(s); p; p = parent.get(p)) {
      if (seen.has(p)) {
        parent.delete(s);
        break;
      }
      seen.add(p);
    }
  }
  return parent;
}

// One lane per session that has a span. Top-level lanes are ordered by first span
// start. A session a /clear started sits directly under the session it replaced
// (clearParents), with follows set to that session's lane; two such sessions go
// earliest first. Each bar is { start, end, x, width, open }. The last span of a live
// session runs to now and is open, but only when its last call is within
// liveWindowMs of now. A session counts as live on its transcript's mtime, which can
// be newer than its last call, and stretching the bar then would draw activity that
// did not happen. A bar is at least minWidth px wide, so a one-call span still shows.
// liveWindowMs matches LIVE_WINDOW_MS in lib/sessions.js.
function laneLayout(sessions, xOf, now, minWidth = 3, liveWindowMs = 10 * 60 * 1000) {
  const shown = sessions.filter((s) => s.spans.length);
  const parent = clearParents(sessions, shown);
  const byStart = (a, b) => a.spans[0][0] - b.spans[0][0];
  const children = new Map();
  for (const [s, p] of parent) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(s);
  }
  const ordered = [];
  const visit = (s) => {
    ordered.push(s);
    for (const child of (children.get(s) || []).sort(byStart)) visit(child);
  };
  for (const s of shown.filter((x) => !parent.has(x)).sort(byStart)) visit(s);

  const laneOf = new Map();
  return ordered.map((session, lane) => {
    const last = session.spans.length - 1;
    const bars = session.spans.map(([start, end], i) => {
      const open = i === last && session.live === true && now - end <= liveWindowMs;
      const to = open ? now : end;
      const x = xOf(start);
      return { start, end: to, x, width: Math.max(minWidth, xOf(to) - x), open };
    });
    const result = { session, lane, bars, follows: parent.has(session) ? laneOf.get(parent.get(session)) : null };
    laneOf.set(session, result);
    return result;
  });
}

// The Session timeline's /clear link: a cubic curve from (x1, y1), the end of the
// old session's last bar, to (x2, y2), the start of the new session's first bar. It
// leaves and arrives horizontally. The control points sit 60% of the gap in from each
// end, and at least 10px, so a next session that starts before the old one's bar
// ends still gets a curve.
function linkPath(x1, y1, x2, y2) {
  const k = Math.max(10, (x2 - x1) * 0.6);
  return `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`;
}

// The Session timeline's prompt-cache rebuild marks for one lane, in time order.
// A rebuild less than minGapPx right of the current mark's x joins that mark, so a
// burst of subagent rebuilds draws as one mark with a count. The gap is measured
// from the mark's first item, so a chain of close rebuilds still splits. main is
// true when any item is a main-thread rebuild, and the page draws such a mark filled.
function rebuildMarks(rebuilds, xOf, minGapPx = 8) {
  const marks = [];
  for (const r of [...rebuilds].sort((a, b) => a.t - b.t)) {
    const x = xOf(r.t);
    const last = marks[marks.length - 1];
    if (last && x - last.x < minGapPx) {
      last.items.push(r);
      last.main = last.main || r.main;
    } else {
      marks.push({ x, items: [r], main: r.main });
    }
  }
  return marks;
}

// The time axis for a range of the picker. days is a number of days or null (all
// history). The end stays at the full domain's end. The start never goes before
// the full domain's start, so a range longer than the data shows the data only.
function rangeDomain(fullDomain, days) {
  if (days == null) return fullDomain;
  return [Math.max(fullDomain[0], fullDomain[1] - days * 24 * 60 * 60 * 1000), fullDomain[1]];
}

// The Setup changes timeline. Lane kinds, top to bottom. A kind that is not listed
// draws in the 'other' lane, as MARKER_SHAPES in public/charts/setup-changes.mjs does.
const LANE_KINDS = ['claude-code', 'claude-md', 'skill', 'plugin', 'hook', 'config', 'rtk', 'model', 'effort', 'other'];

function laneKindOf(marker) {
  return LANE_KINDS.includes(marker.kind) ? marker.kind : 'other';
}

// Two markers are the same change when time and label match. The picked change is
// remembered by this key, because a report reload builds new marker objects.
function markerKey(marker) {
  return `${marker.t}|${marker.label}`;
}

// The markers inside the time axis, edges included. A domain of [Infinity, -Infinity]
// (a report with no sessions and no daily days) holds none.
function markersInDomain(markers, domain) {
  return markers.filter((m) => m.t >= domain[0] && m.t <= domain[1]);
}

function laneKinds(markers) {
  const present = new Set(markers.map(laneKindOf));
  return LANE_KINDS.filter((kind) => present.has(kind));
}

function localMidnight(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Calendar arithmetic, not +24h, so a day with a clock change still ends at midnight.
function addLocalDays(t, days) {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function mondayOf(t) {
  const d = new Date(localMidnight(t));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// One cell per kind per day, or per Monday-start week when a day is under 16px wide.
// Each cell is { kind, start, end, markers }: start and end are local midnights
// (end exclusive) and markers run oldest first. Cells sort by lane order, then start.
// Markers outside the domain are left out.
function laneCells(markers, domain, dayWidth) {
  const weekly = dayWidth < 16;
  const cells = new Map();
  for (const m of markersInDomain(markers, domain)) {
    const kind = laneKindOf(m);
    const start = weekly ? mondayOf(m.t) : localMidnight(m.t);
    const id = `${kind}|${start}`;
    if (!cells.has(id)) cells.set(id, { kind, start, end: addLocalDays(start, weekly ? 7 : 1), markers: [] });
    cells.get(id).markers.push(m);
  }
  const lane = (cell) => LANE_KINDS.indexOf(cell.kind);
  return [...cells.values()]
    .map((cell) => ({ ...cell, markers: cell.markers.sort((a, b) => a.t - b.t) }))
    .sort((a, b) => lane(a) - lane(b) || a.start - b.start);
}

function pickInCell(cell) {
  return cell.markers.reduce((newest, m) => (m.t >= newest.t ? m : newest));
}

// The picked marker if it is inside the domain, else the newest marker inside it,
// else null.
function resolvePicked(markers, pickedKey, domain) {
  const inside = markersInDomain(markers, domain);
  if (!inside.length) return null;
  return inside.find((m) => markerKey(m) === pickedKey) || inside.reduce((newest, m) => (m.t >= newest.t ? m : newest));
}

// Whole and part days from a change to now, for "AFTER · N OF 7 DAYS". Never above 7.
function afterDaysSoFar(t, now) {
  return Math.min(7, Math.max(0, Math.ceil((now - t) / (24 * 60 * 60 * 1000))));
}

// A day label fits in 28px. Narrower days label Mondays only.
function dateLabelStep(dayWidth) {
  return dayWidth >= 28 ? 'day' : 'monday';
}

// Local noon of every day whose noon lies in the domain. The charts centre a day's
// bar and label on its noon.
function domainDays(domain) {
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1])) return [];
  const d = new Date(domain[0]);
  d.setHours(12, 0, 0, 0);
  if (d.getTime() < domain[0]) d.setDate(d.getDate() + 1);
  const days = [];
  for (; d.getTime() <= domain[1]; d.setDate(d.getDate() + 1)) days.push(d.getTime());
  return days;
}

// Count of a session's rebuilds (main and subagent) and the sum of the premiums that
// are numbers. premium is null when none is, so an unpriced model shows no amount.
function rebuildTotals(rebuilds) {
  const list = rebuilds || [];
  const priced = list.filter((r) => typeof r.premium === 'number');
  return { count: list.length, premium: priced.length ? priced.reduce((sum, r) => sum + r.premium, 0) : null };
}

if (typeof module === 'object') module.exports = {
  rebuildTotals, linkPath,
  labelStep, barSlots, axisScale, tooltipPosition, mixEntries, hourTicks, laneLayout, rebuildMarks, rangeDomain,
  markerKey, markersInDomain, laneKinds, laneCells, pickInCell, resolvePicked, afterDaysSoFar, dateLabelStep, domainDays,
};
