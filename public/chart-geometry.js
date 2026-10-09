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
// patterns in user space (appendPatternDefs in app.js), so the pattern lines up
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

// Annular-sector paths for a donut chart, one entry per input value, in order.
// Slices start at 12 o'clock and run clockwise; start and end are radians from
// 12 o'clock. A zero value returns { fraction: 0 } with no path. A value that is the
// whole total cannot be one arc (its start and end points coincide), so it returns
// { full: true, fraction: 1 } and the caller draws a ring. Empty input or a zero
// total returns [].
function donutSlices(values, cx, cy, rOuter, rInner) {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!total) return [];

  const point = (r, angle) => {
    const x = Number((cx + r * Math.sin(angle)).toFixed(3));
    const y = Number((cy - r * Math.cos(angle)).toFixed(3));
    return `${x} ${y}`;
  };

  let angle = 0;
  return values.map((value) => {
    if (!value) return { fraction: 0 };
    const fraction = value / total;
    if (fraction === 1) return { full: true, fraction: 1 };

    const start = angle;
    const end = angle + fraction * 2 * Math.PI;
    angle = end;
    const large = fraction > 0.5 ? 1 : 0;
    const d =
      `M ${point(rOuter, start)} A ${rOuter} ${rOuter} 0 ${large} 1 ${point(rOuter, end)} ` +
      `L ${point(rInner, end)} A ${rInner} ${rInner} 0 ${large} 0 ${point(rInner, start)} Z`;
    return { d, start, end, fraction };
  });
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

// One lane per session that has a span, earliest first span at the top. Each bar
// is { start, end, x, width, open }. The last span of a live session runs to now
// and is open, but only when its last call is within liveWindowMs of now. A session
// counts as live on its transcript's mtime, which can be newer than its last call,
// and stretching the bar then would draw activity that did not happen. A bar is at
// least minWidth px wide, so a one-call span still shows. liveWindowMs matches
// LIVE_WINDOW_MS in lib/sessions.js.
function laneLayout(sessions, xOf, now, minWidth = 3, liveWindowMs = 10 * 60 * 1000) {
  return sessions
    .filter((s) => s.spans.length)
    .sort((a, b) => a.spans[0][0] - b.spans[0][0])
    .map((session, lane) => {
      const last = session.spans.length - 1;
      const bars = session.spans.map(([start, end], i) => {
        const open = i === last && session.live === true && now - end <= liveWindowMs;
        const to = open ? now : end;
        const x = xOf(start);
        return { start, end: to, x, width: Math.max(minWidth, xOf(to) - x), open };
      });
      return { session, lane, bars };
    });
}

// The time axis for a range of the picker. days is a number of days or null (all
// history). The end stays at the full domain's end. The start never goes before
// the full domain's start, so a range longer than the data shows the data only.
function rangeDomain(fullDomain, days) {
  if (days == null) return fullDomain;
  return [Math.max(fullDomain[0], fullDomain[1] - days * 24 * 60 * 60 * 1000), fullDomain[1]];
}

// Rows for glyphs drawn in order at the given x positions. A glyph closer than gap
// px to the one before it continues a chain and sits one row lower. A chain shows
// at most cap glyphs; the rest are hidden and collected in one overflow per chain.
// Returns { glyphs: [{ row, hidden }] per input x, overflows: [{ x, row, indices }],
// rows }. An overflow's x is the x of the chain's first hidden glyph, and its row is
// cap, the row after the last shown glyph. rows is the row count the rail needs.
function stackGlyphs(xs, gap = 12, cap = 5) {
  const glyphs = [];
  const overflows = [];
  let rows = xs.length ? 1 : 0;
  let lastX = -Infinity;
  let row = 0;
  xs.forEach((x, i) => {
    row = x - lastX < gap ? row + 1 : 0;
    lastX = x;
    const hidden = row >= cap;
    glyphs.push({ row: hidden ? cap : row, hidden });
    if (!hidden) {
      rows = Math.max(rows, row + 1);
      return;
    }
    if (row === cap) overflows.push({ x, row: cap, indices: [] });
    overflows[overflows.length - 1].indices.push(i);
    rows = Math.max(rows, cap + 1);
  });
  return { glyphs, overflows, rows };
}

if (typeof module === 'object') module.exports = { labelStep, barSlots, axisScale, tooltipPosition, donutSlices, hourTicks, laneLayout, rangeDomain, stackGlyphs };
