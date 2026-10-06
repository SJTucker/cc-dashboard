'use strict';

// Loaded two ways: index.html loads it as a script before app.js, which makes these
// functions globals, and the tests load it with require().

// Draw every how-many-th x-axis label. Labels stay at least minGap pixels apart,
// and a chart never shows more than 12. "00:00" in the axis font is about 30px
// wide, so 44px leaves a visible space between neighbouring labels.
function labelStep(count, plotWidth, minGap = 44) {
  const fit = Math.max(1, Math.min(12, Math.floor(plotWidth / minGap)));
  return Math.max(1, Math.ceil(count / fit));
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

if (typeof module === 'object') module.exports = { labelStep, tooltipPosition, donutSlices };
