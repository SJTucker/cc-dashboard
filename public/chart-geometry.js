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

if (typeof module === 'object') module.exports = { labelStep, tooltipPosition };
