'use strict';

// #region utils

function formatCost(usd) {
  if (usd == null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatPercent(x) {
  if (x == null) return '—';
  return (x * 100).toFixed(1) + '%';
}

// Wall and API durations for the Live sessions panel.
function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// How long ago a session last wrote to its transcript. After an hour the clock
// time reads better than "137m ago".
function formatAgo(ms, now = Date.now()) {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Mirrors localDateStr in lib/scan.js so the front end can tell which bucket is
// today without parsing a locale-formatted string.
function localDateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Average cost per COMPLETE day. Today is excluded because it is partial and
// would drag the average down. The divisor is the calendar span between the
// first and last complete bucket, not the bucket count. scanUsage fills idle
// days with zero buckets, so the two are equal for its output. The span still
// gives the right rate for a daily list with days missing.
function costPerDay(daily) {
  const today = localDateStr(new Date());
  const complete = daily.filter((d) => d.date !== today);
  if (!complete.length) return null;
  const first = new Date(complete[0].date + 'T00:00:00');
  const last = new Date(complete[complete.length - 1].date + 'T00:00:00');
  const span = Math.round((last - first) / 86400000) + 1;
  // Hour keys ('2026-09-21T14') do not parse as a date, which would make span
  // NaN. Only the daily ranges call this today, but nothing in the signature
  // says so.
  if (!Number.isFinite(span) || span <= 0) return null;
  const total = complete.reduce((sum, d) => sum + d.cost, 0);
  return total / span;
}

// Bucket keys are either '2026-09-21' (day) or '2026-09-21T14' (hour).
function shortDate(key) {
  if (key.includes('T')) return key.slice(-2) + ':00';
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function fullDate(key) {
  if (key.includes('T')) {
    const [date, hour] = key.split('T');
    return `${date} ${hour}:00`;
  }
  return key;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const tooltip = document.getElementById('tooltip');

// The tooltip is measured after its content is set, so tooltipPosition can keep
// the whole of it inside the viewport.
function showTooltip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pos = tooltipPosition(evt.clientX, evt.clientY, tooltip.offsetWidth, tooltip.offsetHeight, innerWidth, innerHeight);
  tooltip.style.left = pos.left + 'px';
  tooltip.style.top = pos.top + 'px';
}

function hideTooltip() {
  tooltip.hidden = true;
}

// Model names come from log files on disk, so they are escaped before reaching
// innerHTML. Dates and fixed labels elsewhere in the tooltips are generated here.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// #endregion

// #region charts (plain SVG bars - no chart library, nothing loaded from a CDN)

const CHART_HEIGHT = 180;
const CHART_PAD_LEFT = 46;
const CHART_PAD_BOTTOM = 20;

// Axis ticks are round by construction, so formatTokens' fixed 2 decimals only adds
// "200.00M" where "200M" says the same thing in less width.
function axisTokens(n) {
  return formatTokens(n).replace(/\.0+(?=[kMB]$)/, '');
}

// A compact cost for the y axis: formatCost's grouped "$1,200.00" is wider than the
// axis gutter.
// Gridline values are round by construction but not whole: drawYAxis picks a
// step of 0.5 whenever the max lands in (0.80, 2.00], so dropping the cents
// labelled the $1.50 line "$2" and left two ticks reading the same number.
function axisCost(usd) {
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'k';
  if (usd >= 10) return '$' + usd.toFixed(0);
  return '$' + usd.toFixed(2).replace(/\.00$/, '');
}

// Rounds the top of the scale up to the next 1/2/5 x 10^n tick, draws the gridlines
// and their labels, and returns that rounded max for the bars to scale against. The
// point is reading a value off the chart without hovering, so the ticks have to be
// round numbers, which means the scale top follows from the tick step rather than
// from the data max.
function drawYAxis(svg, rawMax, width, format, ticks = 4) {
  const rough = Math.max(rawMax, 1e-9) / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const n = rough / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  const max = Math.ceil(rawMax / step) * step;
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;

  for (let i = 1; i * step <= max * 1.0001; i++) {
    const value = i * step;
    const y = plotHeight - (value / max) * plotHeight;
    svg.appendChild(svgEl('line', { class: 'gridline', x1: CHART_PAD_LEFT, x2: width, y1: y, y2: y }));
    const label = svgEl('text', {
      class: 'axis-label', x: CHART_PAD_LEFT - 6, y: y + 3, 'text-anchor': 'end',
    });
    label.textContent = format(value);
    svg.appendChild(label);
  }
  return max;
}

function chartWidth(container) {
  return Math.max(container.clientWidth, 200);
}

function drawBarChart(container, data, { color, valueKey, tooltipFn }) {
  hideTooltip();
  container.innerHTML = '';
  const allZero = data.every((d) => !d[valueKey]);
  if (!data.length || allZero) {
    const text = data.length && valueKey === 'cost'
      ? 'No priced usage in this range.'
      : 'No usage in this range.';
    container.appendChild(el('div', { class: 'bar-empty', text }));
    return;
  }

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const rawMax = Math.max(...data.map((d) => d[valueKey]), 0.0001);
  const barGap = 3;
  const barWidth = Math.max((width - CHART_PAD_LEFT) / data.length - barGap, 2);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  const max = drawYAxis(svg, rawMax, width, valueKey === 'cost' ? axisCost : axisTokens);

  // Zero line
  svg.appendChild(
    svgEl('line', {
      x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight,
      stroke: 'var(--border)', 'stroke-width': 1,
    })
  );

  data.forEach((d, i) => {
    const value = d[valueKey];
    const barHeight = max > 0 ? (value / max) * plotHeight : 0;
    const x = CHART_PAD_LEFT + i * (barWidth + barGap);
    const y = plotHeight - barHeight;

    const rect = svgEl('rect', {
      class: 'bar',
      x, y, width: barWidth, height: Math.max(barHeight, value > 0 ? 1 : 0),
      rx: 2,
      fill: color,
    });
    rect.addEventListener('mousemove', (evt) => showTooltip(evt, tooltipFn(d)));
    rect.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(rect);

    // Show a date label every Nth bar so labels don't overlap on wide ranges.
    const labelEvery = labelStep(data.length, width - CHART_PAD_LEFT);
    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label',
        x: x + barWidth / 2, y: CHART_HEIGHT - 4,
        'text-anchor': 'middle',
      });
      label.textContent = shortDate(d.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

// A running total across the range's buckets. One path, plus a transparent
// hover target per bucket so the tooltip works anywhere in a column rather than
// only within a few pixels of the line.
function drawCumulativeChart(container, data) {
  hideTooltip();
  container.innerHTML = '';
  if (!data.length || data.every((d) => !d.cost)) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No priced usage in this range.' }));
    return;
  }

  let running = 0;
  const points = data.map((d) => ({ date: d.date, total: (running += d.cost) }));

  // Buckets outside the spending are zero-filled - the Today range always carries
  // a full 24-hour axis - and a flat line across them reads as usage continuing at
  // that level rather than as nothing happening. The line is drawn only over the
  // buckets that spent, starting one earlier so it still rises from zero. A flat
  // stretch BETWEEN two spends stays, because that is what a cumulative total
  // genuinely does there. The axis keeps its full width either way, so the labels
  // do not move.
  const drawTo = data.map((d) => d.cost > 0).lastIndexOf(true);
  const drawFrom = Math.max(data.findIndex((d) => d.cost > 0) - 1, 0);
  const drawn = points.slice(drawFrom, drawTo + 1);

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const step = (width - CHART_PAD_LEFT) / Math.max(points.length - 1, 1);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  const max = drawYAxis(svg, points[points.length - 1].total, width, axisCost);
  svg.appendChild(
    svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 })
  );

  const xAt = (i) => CHART_PAD_LEFT + i * step;
  const yAt = (total) => plotHeight - (total / max) * plotHeight;

  // A one-bucket range yields a moveto with no lineto, which draws nothing at
  // all. Give it a short horizontal segment so a single day still shows its
  // running total instead of an apparently empty panel.
  const d =
    drawn.length === 1
      ? `M${xAt(drawFrom)},${yAt(drawn[0].total)} L${xAt(drawFrom) + Math.max(step, 2)},${yAt(drawn[0].total)}`
      : drawn.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(drawFrom + i)},${yAt(p.total)}`).join(' ');
  svg.appendChild(svgEl('path', { class: 'cumulative-line', d, fill: 'none' }));

  points.forEach((p, i) => {
    if (i >= drawFrom && i <= drawTo) {
      const hit = svgEl('rect', {
        x: xAt(i) - step / 2, y: 0, width: Math.max(step, 1), height: plotHeight, fill: 'transparent',
      });
      hit.addEventListener('mousemove', (evt) =>
        showTooltip(evt, `<b>${fullDate(p.date)}</b><br>Running total: ${formatCost(p.total)}`)
      );
      hit.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(hit);
    }

    const labelEvery = labelStep(points.length, width - CHART_PAD_LEFT);
    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label', x: xAt(i), y: CHART_HEIGHT - 4, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(p.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

// `dash` is the stroke-dasharray the log line chart draws each series with. It is
// the identity channel that survives colourblindness and greyscale printing, the
// same job `texture` does for the stacked bars. Colour is the secondary channel in
// both.
const TOKEN_SERIES = [
  { key: 'input', label: 'Input', color: '#c98500', texture: 'diag', dash: '2 4' },
  { key: 'output', label: 'Output', color: '#3987e5', texture: 'diag-rev', dash: '9 4' },
  { key: 'cacheCreate', label: 'Cache write', color: '#d55181', texture: 'dots', dash: '9 4 2 4' },
  { key: 'cacheRead', label: 'Cache read', color: '#9085e9', texture: 'solid', dash: null },
];

// Validated with the dataviz skill's validate_palette.js against this dashboard's
// panel surface (#171d27, dark): every check passes, worst adjacent CVD ΔE 16.0
// (deutan). No red/green pair appears - the user is red-green colourblind. Texture
// is the primary identity channel here; colour is the secondary one.
const MODEL_STYLE = {
  opus: { color: '#d55181', texture: 'dots' },
  sonnet: { color: '#9085e9', texture: 'solid' },
  haiku: { color: '#c98500', texture: 'diag' },
  fable: { color: '#3987e5', texture: 'diag-rev' },
  mythos: { color: '#199e70', texture: 'cross' },
  other: { color: '#5c6779', texture: 'solid' },
};

// The payload carries the family key on every models[] entry and uses it for the
// byModel keys, so the matching rules live only in lib/pricing.js.
function modelColor(family) {
  return (MODEL_STYLE[family] || MODEL_STYLE.other).color;
}

function modelTexture(family) {
  return (MODEL_STYLE[family] || MODEL_STYLE.other).texture;
}

// One <defs> block per chart. A pattern is keyed by texture name AND colour,
// because an SVG pattern carries its own paint - two series sharing a texture at
// different colours need two pattern elements. It is also keyed by a chart scope:
// SVG ids are document-global, three charts can be on the page at once, and the
// token and model palettes reuse the same four hex values, so without a scope two
// charts would emit colliding ids for different patterns.
function patternId(scope, texture, color) {
  return `tex-${scope}-${texture}-${color.replace('#', '')}`;
}

// One vocabulary for both renderers. The charts paint SVG <pattern> elements; the
// legend swatches and the HTML mix bar paint CSS gradients. They were previously
// written out separately and drifted: the SVG and CSS diagonals ended up mirrored,
// so a legend swatch identified the wrong series. Both sides now come from here.
// Note the axis convention differs - SVG y grows downward, and a CSS gradient's
// bands run perpendicular to its angle - so the paired values below look unrelated
// but render the same way. Verify visually if you change either.
const TEXTURES = {
  // backslash "\"
  diag: {
    svg: (ink) => svgEl('path', { d: 'M0,0 l6,6', stroke: ink, 'stroke-width': 2 }),
    css: (color, ink) => `repeating-linear-gradient(45deg, ${color} 0 4px, ${ink} 4px 6px)`,
  },
  // forward slash "/"
  'diag-rev': {
    svg: (ink) => svgEl('path', { d: 'M0,6 l6,-6', stroke: ink, 'stroke-width': 2 }),
    css: (color, ink) => `repeating-linear-gradient(-45deg, ${color} 0 4px, ${ink} 4px 6px)`,
  },
  dots: {
    svg: (ink) => svgEl('circle', { cx: 3, cy: 3, r: 1.4, fill: ink }),
    css: (color, ink) => `radial-gradient(${ink} 1.4px, ${color} 1.5px) 0 0/6px 6px`,
  },
  cross: {
    svg: (ink) => svgEl('path', { d: 'M0,3 h6 M3,0 v6', stroke: ink, 'stroke-width': 1.2 }),
    // The first layer must be transparent where it is not ink, or it paints over the
    // second and the grid renders as plain horizontal stripes.
    css: (color, ink) => `repeating-linear-gradient(0deg, transparent 0 4px, ${ink} 4px 5px), repeating-linear-gradient(90deg, ${color} 0 4px, ${ink} 4px 5px)`,
  },
  solid: { svg: null, css: (color) => color },
};

const TEXTURE_INK = '#05070d';

// CSS `background` value for a texture, used by every legend swatch and the mix bar.
function textureCss(texture, color) {
  const entry = TEXTURES[texture] || TEXTURES.solid;
  return entry.css(color, TEXTURE_INK);
}

function appendPatternDefs(svg, scope, series) {
  const defs = svgEl('defs');
  const seen = new Set();

  for (const { texture, color } of series) {
    const id = patternId(scope, texture, color);
    if (seen.has(id)) continue;
    seen.add(id);

    const entry = TEXTURES[texture] || TEXTURES.solid;
    // 'solid' has no overlay and fillFor() returns the raw colour for it, so no
    // pattern element is ever referenced for it - skip emitting one.
    if (!entry.svg) continue;

    const pattern = svgEl('pattern', {
      id, width: 6, height: 6, patternUnits: 'userSpaceOnUse',
    });
    pattern.appendChild(svgEl('rect', { width: 6, height: 6, fill: color }));

    // The overlay is drawn in the page background colour so a texture reads as a
    // cut-out rather than a second hue - it stays legible in forced-colours mode
    // and in print.
    pattern.appendChild(entry.svg(TEXTURE_INK));

    defs.appendChild(pattern);
  }

  svg.appendChild(defs);
}

function fillFor(scope, texture, color) {
  return texture === 'solid' ? color : `url(#${patternId(scope, texture, color)})`;
}

// CSS equivalent of the SVG patterns, for the HTML mix bar. Same texture table, so a
// family looks identical in the mix bar and in the chart.
function segmentTexture(family) {
  const { color, texture } = MODEL_STYLE[family] || MODEL_STYLE.other;
  return `background:${textureCss(texture, color)}`;
}

function drawStackedChart(container, data, series = TOKEN_SERIES) {
  hideTooltip();
  container.innerHTML = '';
  const seriesTotal = (d) => series.reduce((s, ser) => s + d[ser.key], 0);
  if (!data.length || data.every((d) => !seriesTotal(d))) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No usage in this range.' }));
    return;
  }

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const totals = data.map((d) => series.reduce((s, ser) => s + d[ser.key], 0));
  const rawMax = Math.max(...totals, 1);
  const barGap = 3;
  const barWidth = Math.max((width - CHART_PAD_LEFT) / data.length - barGap, 2);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  appendPatternDefs(svg, 'token', series);
  const max = drawYAxis(svg, rawMax, width, axisTokens);
  svg.appendChild(
    svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 })
  );

  data.forEach((d, i) => {
    const x = CHART_PAD_LEFT + i * (barWidth + barGap);
    let cursorY = plotHeight;

    for (const ser of series) {
      const value = d[ser.key];
      if (!value) continue;
      const segHeight = (value / max) * plotHeight;
      const y = cursorY - segHeight;
      const rect = svgEl('rect', {
        class: 'bar',
        x, y, width: barWidth, height: Math.max(segHeight, 0.5),
        fill: fillFor('token', ser.texture, ser.color),
      });
      rect.addEventListener('mousemove', (evt) =>
        showTooltip(
          evt,
          `<b>${fullDate(d.date)}</b><br>${ser.label}: ${formatTokens(value)} tokens (${((value / totals[i]) * 100).toFixed(1)}%)<br>Bucket total: ${formatTokens(totals[i])} tokens`
        )
      );
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
      cursorY = y;
    }

    const labelEvery = labelStep(data.length, width - CHART_PAD_LEFT);
    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label', x: x + barWidth / 2, y: CHART_HEIGHT - 4, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(d.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

// Daily tokens for all four types in one plot. The four span six orders of
// magnitude on a typical range - 78 input tokens against 452M cache reads - which
// a linear axis cannot show: input and output sit below one pixel. A log axis can,
// but it rules out bars, because a bar's length is measured from zero and a log
// axis has no zero, and stacked segments do not add in log space. So the marks are
// lines. Read it for the gaps between the lines (cache read runs ~400x output) and
// for each line's slope, not for area.
function drawLogLineChart(container, data, series = TOKEN_SERIES) {
  hideTooltip();
  container.innerHTML = '';
  const positive = data.flatMap((d) => series.map((ser) => d[ser.key])).filter((v) => v > 0);
  if (!data.length || !positive.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No usage in this range.' }));
    return;
  }

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  // Headroom at the top so the highest decade's label is not clipped by the
  // viewBox: it sits at the very top of the plot and its ascender would otherwise
  // fall outside. There is no right gutter - the legend beside the chart names the
  // series, in the same top-to-bottom order the lines run, so the plot gets the
  // full width.
  const padTop = 9;
  const step = (width - CHART_PAD_LEFT) / Math.max(data.length - 1, 1);
  const xAt = (i) => CHART_PAD_LEFT + i * step;

  // Whole decades only. A log axis labelled with anything but powers of ten is
  // unreadable, and rounding the domain out to decade boundaries keeps every line
  // inside the plot without a separate headroom calculation. The span floor of 1
  // covers a range whose values all sit inside one decade, which would otherwise
  // divide by zero.
  const loExp = Math.floor(Math.log10(Math.min(...positive)));
  const hiExp = Math.ceil(Math.log10(Math.max(...positive)));
  const span = Math.max(hiExp - loExp, 1);
  const yAt = (v) => plotHeight - ((Math.log10(v) - loExp) / span) * (plotHeight - padTop);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });

  // One gridline per decade, thinned to every other one when nine decades would
  // otherwise crowd 160px of plot into unreadable 18px bands.
  const labelEveryDecade = span <= 6 ? 1 : 2;
  for (let e = loExp; e <= loExp + span; e++) {
    const y = yAt(10 ** e);
    svg.appendChild(svgEl('line', { class: 'gridline', x1: CHART_PAD_LEFT, x2: width, y1: y, y2: y }));
    if ((loExp + span - e) % labelEveryDecade !== 0) continue;
    const label = svgEl('text', { class: 'axis-label', x: CHART_PAD_LEFT - 6, y: y + 3, 'text-anchor': 'end' });
    label.textContent = axisTokens(10 ** e);
    svg.appendChild(label);
  }

  // Zero is not a point on a log axis, so a bucket with none of a given token type
  // breaks that line rather than being drawn at the floor. Clamping it to the
  // bottom would draw a value that never happened - the hourly Today buckets are
  // zero-filled, so this is the common case, not an edge one.
  for (const ser of series) {
    let d = '';
    let open = false;
    data.forEach((row, i) => {
      const v = row[ser.key];
      if (!(v > 0)) { open = false; return; }
      d += `${open ? 'L' : 'M'}${xAt(i)},${yAt(v)} `;
      open = true;
    });
    // A lone point between two gaps is a moveto with no lineto and draws nothing,
    // so every isolated bucket also gets a dot.
    svg.appendChild(
      svgEl('path', {
        class: 'log-line', d: d.trim(), fill: 'none', stroke: ser.color,
        ...(ser.dash ? { 'stroke-dasharray': ser.dash } : {}),
      })
    );
    data.forEach((row, i) => {
      const v = row[ser.key];
      const prev = data[i - 1] && data[i - 1][ser.key] > 0;
      const next = data[i + 1] && data[i + 1][ser.key] > 0;
      if (v > 0 && !prev && !next) {
        svg.appendChild(svgEl('circle', { cx: xAt(i), cy: yAt(v), r: 2, fill: ser.color }));
      }
    });
  }

  const crosshair = svgEl('line', { class: 'crosshair', y1: 0, y2: plotHeight, visibility: 'hidden' });
  svg.appendChild(crosshair);

  // One full-height hit target per bucket rather than per mark: on a line chart the
  // question is always "what were all four on this day", and a 2px stroke is far too
  // small to aim at.
  data.forEach((row, i) => {
    const hit = svgEl('rect', {
      x: xAt(i) - step / 2, y: 0, width: Math.max(step, 1), height: plotHeight, fill: 'transparent',
    });
    hit.addEventListener('mousemove', (evt) => {
      crosshair.setAttribute('x1', xAt(i));
      crosshair.setAttribute('x2', xAt(i));
      crosshair.setAttribute('visibility', 'visible');
      const rows = series
        .map((ser) => `${ser.label}: ${row[ser.key] ? formatTokens(row[ser.key]) : '0'}`)
        .reverse()
        .join('<br>');
      showTooltip(evt, `<b>${fullDate(row.date)}</b><br>${rows}`);
    });
    hit.addEventListener('mouseleave', () => {
      crosshair.setAttribute('visibility', 'hidden');
      hideTooltip();
    });
    svg.appendChild(hit);

    const labelEvery = labelStep(data.length, width - CHART_PAD_LEFT);
    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label', x: xAt(i), y: CHART_HEIGHT - 4, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(row.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

// Same geometry as drawStackedChart, but the segments are models rather than token
// types. Series order is fixed across buckets so a model keeps its vertical position
// and its colour from day to day. mode picks whether the segments measure tokens or
// dollars; the two differ sharply because an Opus token costs five Haiku tokens.
function drawModelDailyChart(container, data, models, mode = 'tokens') {
  const source = mode === 'cost' ? 'costByModel' : 'byModel';
  const axisFmt = mode === 'cost' ? axisCost : axisTokens;
  const tipFmt = mode === 'cost' ? formatCost : (n) => formatTokens(n) + ' tokens';
  const scope = 'model-' + mode;
  hideTooltip();
  container.innerHTML = '';
  // Families, not model names: byModel is family-keyed, and two models of one family
  // share a colour anyway. Deduped so a family with two models yields one segment.
  const order = [...new Set([...models].sort((a, b) => b.tokens - a.tokens).map((m) => m.family))];
  const totals = data.map((d) => order.reduce((s, name) => s + (d[source]?.[name] || 0), 0));

  if (!data.length || totals.every((t) => !t)) {
    container.appendChild(
      el('div', { class: 'bar-empty', text: mode === 'cost' ? 'No priced model usage in this range.' : 'No model usage in this range.' })
    );
    return;
  }

  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const rawMax = Math.max(...totals, 1);
  const barGap = 3;
  const barWidth = Math.max((width - CHART_PAD_LEFT) / data.length - barGap, 2);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT });
  appendPatternDefs(svg, scope, order.map((f) => ({ texture: modelTexture(f), color: modelColor(f) })));
  const max = drawYAxis(svg, rawMax, width, axisFmt);
  svg.appendChild(
    svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)', 'stroke-width': 1 })
  );

  data.forEach((d, i) => {
    const x = CHART_PAD_LEFT + i * (barWidth + barGap);
    let cursorY = plotHeight;

    for (const name of order) {
      const value = d[source]?.[name] || 0;
      if (!value) continue;
      const segHeight = (value / max) * plotHeight;
      const y = cursorY - segHeight;
      const rect = svgEl('rect', {
        class: 'bar',
        x, y, width: barWidth, height: Math.max(segHeight, 0.5),
        fill: fillFor(scope, modelTexture(name), modelColor(name)),
      });
      rect.addEventListener('mousemove', (evt) =>
        showTooltip(
          evt,
          `<b>${fullDate(d.date)}</b><br>${name}: ${tipFmt(value)}<br>Bucket total: ${tipFmt(totals[i])}`
        )
      );
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
      cursorY = y;
    }

    const labelEvery = labelStep(data.length, width - CHART_PAD_LEFT);
    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'axis-label', x: x + barWidth / 2, y: CHART_HEIGHT - 4, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(d.date);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --accent-cost as RGB, so cell intensity can be expressed as an alpha without
// color-mix. Keep in sync with --accent-cost in public/style.css.
const HEAT_RGB = '255, 176, 0';

// One hue varying only in opacity. Magnitude is carried by lightness alone,
// which is why this needs no texture channel the way the categorical charts do.
function drawActivityHeatmap(container, activity) {
  hideTooltip();
  container.innerHTML = '';
  const max = Math.max(...activity.map((c) => c.cost), 0);
  if (!max) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No priced usage in this range.' }));
    return;
  }

  const grid = el('div', { class: 'heatmap' });

  for (let weekday = 0; weekday < 7; weekday++) {
    grid.appendChild(el('div', { class: 'heat-row-label', text: WEEKDAY_LABELS[weekday] }));
    for (let hour = 0; hour < 24; hour++) {
      const c = activity[weekday * 24 + hour];
      const cell = el('div', { class: 'heat-cell' });
      if (c.cost > 0) {
        // Floor the alpha at 0.12 so the cheapest non-zero hour is still
        // visible rather than indistinguishable from an idle one.
        const alpha = 0.12 + 0.88 * (c.cost / max);
        cell.style.background = `rgba(${HEAT_RGB}, ${alpha})`;
      }
      cell.addEventListener('mousemove', (evt) =>
        showTooltip(
          evt,
          `<b>${WEEKDAY_LABELS[weekday]} ${String(hour).padStart(2, '0')}:00</b><br>${formatCost(c.cost)}<br>${c.calls} calls, ${formatTokens(c.tokens)} tokens`
        )
      );
      cell.addEventListener('mouseleave', hideTooltip);
      grid.appendChild(cell);
    }
  }

  container.appendChild(grid);

  const axis = el('div', { class: 'heat-hours' });
  for (let hour = 0; hour < 24; hour += 3) {
    axis.appendChild(el('span', { text: String(hour).padStart(2, '0') }));
  }
  container.appendChild(axis);
}

// A legend sample for a line chart: a short SVG line with the series' own colour
// and dash pattern, so each entry matches its line by dash and not only by colour.
// 28px holds a whole '9 4 2 4' cycle and the start of the next one. At 16px that
// pattern looked the same as '9 4'.
function legendLineSample(ser) {
  const svg = svgEl('svg', { class: 'legend-line', width: 28, height: 4, viewBox: '0 0 28 4', 'aria-hidden': 'true' });
  svg.appendChild(
    svgEl('line', {
      x1: 0, y1: 2, x2: 28, y2: 2, stroke: ser.color, 'stroke-width': 2,
      ...(ser.dash ? { 'stroke-dasharray': ser.dash } : {}),
    })
  );
  return svg;
}

function drawTokenLegend(container, data, series = TOKEN_SERIES, lineStyle = false) {
  container.innerHTML = '';
  for (const ser of series) {
    const total = (data || []).reduce((sum, d) => sum + (d[ser.key] || 0), 0);

    container.appendChild(
      el('span', { class: 'legend-item' }, [
        lineStyle
          ? legendLineSample(ser)
          : el('span', { class: 'legend-swatch', style: `background:${textureCss(ser.texture, ser.color)}` }),
        el('span', { text: total ? `${ser.label} ${formatTokens(total)}` : ser.label }),
      ])
    );
  }
}

// A single composition bar: each model's share of tokens across the whole range.
// Sized by tokens, not cost - the Cost by model panel below already carries dollars,
// and the contrast between the two is the point (a model can be 40% of volume and
// 5% of spend).
function drawModelMix(container, legendContainer, models) {
  hideTooltip();
  container.innerHTML = '';
  legendContainer.innerHTML = '';

  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  if (!total) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No model usage in this range.' }));
    return;
  }

  const sorted = [...models].sort((a, b) => b.tokens - a.tokens);

  for (const m of sorted) {
    const pct = (m.tokens / total) * 100;
    const seg = el('div', {
      class: 'mix-seg',
      style: `width:${pct}%;${segmentTexture(m.family)}`,
      title: `${shortModel(m.model)} — ${formatTokens(m.tokens)} tokens (${pct.toFixed(1)}%)`,
    });
    seg.addEventListener('mousemove', (evt) =>
      showTooltip(evt, `<b>${escapeHtml(shortModel(m.model))}</b><br>${formatTokens(m.tokens)} tokens<br>${pct.toFixed(1)}% of range`)
    );
    seg.addEventListener('mouseleave', hideTooltip);
    container.appendChild(seg);

    // Direct-label each series: identity is never carried by colour alone.
    legendContainer.appendChild(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: segmentTexture(m.family) }),
        el('span', { text: `${shortModel(m.model)} ${pct.toFixed(0)}%` }),
      ])
    );
  }
}

// Two shares of one whole, drawn as a single split bar. Main-thread vs subagent
// and over- vs under-threshold context are both partitions of total cost, so the
// pair reads better as one bar than as two the eye has to add up. The skill and
// subagent lists below are not partitions - one call can appear in both - so they
// keep the separate-bar form.
//
// Validated with the dataviz skill's validate_palette.js against the panel
// surface: CVD deltaE 27.3 (protan). Texture and the direct labels carry identity;
// colour is secondary, as everywhere else here.
const SPLIT_STYLE = [
  { color: '#c98500', texture: 'solid' },
  { color: '#9085e9', texture: 'diag' },
];

function drawSplitBar(container, rows) {
  container.innerHTML = '';
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  if (!(total > 0)) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'Nothing attributed in this range.' }));
    return;
  }

  const bar = el('div', { class: 'mix-bar' });
  const legend = el('div', { class: 'legend split-legend' });

  rows.forEach((row, i) => {
    const pct = (row.cost / total) * 100;
    const style = SPLIT_STYLE[i % SPLIT_STYLE.length];
    const seg = el('div', {
      class: 'mix-seg',
      style: `width:${pct}%;background:${textureCss(style.texture, style.color)}`,
    });
    seg.addEventListener('mousemove', (evt) =>
      showTooltip(evt, `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${pct.toFixed(1)}% of total`)
    );
    seg.addEventListener('mouseleave', hideTooltip);
    bar.appendChild(seg);

    legend.appendChild(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: `background:${textureCss(style.texture, style.color)}` }),
        el('span', { text: `${row.name} ${pct.toFixed(1)}%` }),
      ])
    );
  });

  container.appendChild(bar);
  container.appendChild(legend);
}

// Horizontal bars for the attribution breakdowns. Every bar is scaled against
// one `scaleMax` so lengths stay comparable across groups; the number beside it
// is always the true share of total cost. Row identity comes from the label, so
// a single fill colour is enough and no texture is needed.
function drawUsageBars(container, rows, total, scaleMax) {
  container.innerHTML = '';
  if (!rows.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'Nothing attributed in this range.' }));
    return;
  }

  for (const row of rows) {
    const pct = total > 0 ? (row.cost / total) * 100 : 0;
    const fill = el('i');
    fill.style.width = (scaleMax > 0 ? (row.cost / scaleMax) * 100 : 0) + '%';

    const node = el('div', { class: 'usage-row' }, [
      el('span', { class: 'usage-name', text: row.name, title: row.name }),
      el('span', { class: 'usage-track' }, [fill]),
      el('span', { class: 'usage-pct', text: pct.toFixed(1) + '%' }),
    ]);
    // Skill and subagent names come from log files, so they are escaped here.
    node.addEventListener('mousemove', (evt) =>
      showTooltip(evt, `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${pct.toFixed(1)}% of total`)
    );
    node.addEventListener('mouseleave', hideTooltip);
    container.appendChild(node);
  }
}

// Tool call counts, and the same list one level down. Kept separate from
// drawUsageBars rather than adding options to it: these rows are counts not cost,
// they carry an error rate, and one of them is selected. Folding four behaviours
// into one function costs more than the twenty lines repeated here.
//
// A detail row for Read, Write or Edit is an absolute file path. The name cell
// truncates from the right, which on a path shows the part every row has in common,
// so the basename is displayed and the full path goes in the tooltip.
function toolRowLabel(name) {
  return name.startsWith('/') ? name.split('/').pop() || name : name;
}

// The name of the row in container that has keyboard focus, or null.
// drawToolBars and drawRtkBars rebuild every row on a selection and on each live
// poll, which drops focus to <body>. They call this first, then refocus the row
// with the same name after the rebuild.
function focusedRowName(container) {
  const active = document.activeElement;
  return active && active !== container && container.contains(active) ? active.dataset.name || null : null;
}

function drawToolBars(container, rows, scaleMax, onSelect, selectedName) {
  const refocus = focusedRowName(container);
  container.innerHTML = '';
  if (!rows.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No tool calls in this range.' }));
    return;
  }

  for (const row of rows) {
    const fill = el('i');
    fill.style.width = (scaleMax > 0 ? (row.calls / scaleMax) * 100 : 0) + '%';

    const value = row.errors
      ? `${row.calls.toLocaleString('en-US')} · ${((row.errors / row.calls) * 100).toFixed(1)}% err`
      : row.calls.toLocaleString('en-US');

    // Tool and file names come from log files, so they are escaped before use.
    const node = el('div', { class: 'usage-row' + (onSelect ? ' selectable' : '') + (row.name === selectedName ? ' selected' : '') }, [
      el('span', { class: 'usage-name', text: toolRowLabel(row.name), title: row.name }),
      el('span', { class: 'usage-track' }, [fill]),
      el('span', { class: 'usage-pct usage-count', text: value }),
    ]);
    node.addEventListener('mousemove', (evt) =>
      showTooltip(
        evt,
        `<b>${escapeHtml(row.name)}</b><br>${row.calls.toLocaleString('en-US')} calls` +
          (row.errors ? `<br>${row.errors.toLocaleString('en-US')} returned an error` : '')
      )
    );
    node.addEventListener('mouseleave', hideTooltip);
    if (onSelect) {
      node.addEventListener('click', () => onSelect(row.name));
      node.tabIndex = 0;
      node.dataset.name = row.name;
      node.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          onSelect(row.name);
        }
      });
    }
    container.appendChild(node);
    if (refocus !== null && row.name === refocus) node.focus({ preventScroll: true });
  }
}

// Same two-column shape as drawToolBars, but scaled by tokens saved rather than by
// call count, because "which commands is rtk helping with" is a question about
// tokens. A command with 15,000 cheap calls and one with 127 expensive ones both
// show up honestly this way.
function drawRtkBars(container, rows, scaleMax, onSelect, selectedName) {
  const refocus = focusedRowName(container);
  container.innerHTML = '';
  if (!rows.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No rtk commands in this range.' }));
    return;
  }

  for (const row of rows) {
    const fill = el('i');
    fill.style.width = (scaleMax > 0 ? (row.saved / scaleMax) * 100 : 0) + '%';

    // Command strings come from a file on disk, so el() sets them as text and
    // escapeHtml() guards the tooltip, which is assigned as HTML.
    const node = el('div', { class: 'usage-row' + (onSelect ? ' selectable' : '') + (row.name === selectedName ? ' selected' : '') }, [
      el('span', { class: 'usage-name', text: row.name, title: row.name }),
      el('span', { class: 'usage-track' }, [fill]),
      el('span', { class: 'usage-pct usage-count', text: formatTokens(row.saved) }),
    ]);
    node.addEventListener('mousemove', (evt) =>
      showTooltip(
        evt,
        `<b>${escapeHtml(row.name)}</b><br>${formatTokens(row.saved)} filtered out` +
          `<br>${row.calls.toLocaleString('en-US')} ${row.calls === 1 ? 'call' : 'calls'}`
      )
    );
    node.addEventListener('mouseleave', hideTooltip);
    if (onSelect) {
      node.addEventListener('click', () => onSelect(row.name));
      node.tabIndex = 0;
      node.dataset.name = row.name;
      node.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          onSelect(row.name);
        }
      });
    }
    container.appendChild(node);
    if (refocus !== null && row.name === refocus) node.focus({ preventScroll: true });
  }
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

function renderTools(tools) {
  const panel = document.getElementById('toolPanel');
  panel.hidden = !tools.length;
  if (!tools.length) return;

  if (!tools.some((t) => t.name === selectedTool)) selectedTool = tools[0].name;
  const current = tools.find((t) => t.name === selectedTool);

  const shown = tools.slice(0, 12);
  drawToolBars(
    document.getElementById('toolBars'),
    shown,
    Math.max(...shown.map((t) => t.calls)),
    (name) => {
      selectedTool = name;
      renderTools(tools);
    },
    selectedTool
  );

  document.getElementById('toolDetailTitle').textContent = `Inside ${toolRowLabel(current.name)}`;
  const details = current.details;
  drawToolBars(
    document.getElementById('toolDetailBars'),
    details,
    details.length ? Math.max(...details.map((d) => d.calls)) : 0
  );
  document.getElementById('toolDetailNote').textContent = details.length
    ? ''
    : 'No breakdown for this tool - its input has no field that groups calls.';
  renderToolErrors(current);
}

// rtk figures are deliberately not folded into any summary card. They count output
// bytes rtk filtered before the text reached the model, estimated by rtk's own
// tokeniser; the cards above count tokens Anthropic billed. Adding one to the other
// would produce a number that means nothing.
// Held across renders for the same reason selectedTool is: a range switch or a live
// poll should not throw the reader back to the first command.
let selectedRtkCommand = null;

function renderRtkCommands(commands) {
  if (!commands.some((c) => c.name === selectedRtkCommand)) {
    selectedRtkCommand = commands[0].name;
  }
  const current = commands.find((c) => c.name === selectedRtkCommand);

  const shown = commands.slice(0, 12);
  drawRtkBars(
    document.getElementById('rtkCommandBars'),
    shown,
    Math.max(...shown.map((c) => c.saved)),
    (name) => {
      selectedRtkCommand = name;
      renderRtkCommands(commands);
    },
    selectedRtkCommand
  );

  document.getElementById('rtkDetailTitle').textContent = `Inside rtk ${current.name}`;
  const details = current.details.slice(0, 12);
  drawRtkBars(
    document.getElementById('rtkDetailBars'),
    details,
    details.length ? Math.max(...details.map((d) => d.saved)) : 0
  );
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
// optional: a failure resolves to null and hides both.
function requestLimits() {
  return fetch('/api/limits').then((res) => res.json()).catch(() => null);
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

function renderLimits(limits) {
  const panel = document.getElementById('limitsPanel');
  panel.hidden = !limits || currentDays !== 'today';
  if (panel.hidden) return;
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
    ? ' — may be stale: Claude Code updates it while a session runs'
    : '';
  const sourceLabel = limits.source === 'statusline' ? "Claude Code's statusline" : "Claude Code's usage cache";
  document.getElementById('limitsNote').textContent = `from ${sourceLabel}, as of ${asOf} (${zone})${stale}`;
}

// Today's sessions from the statusline snapshots (see lib/sessions.js). A
// failure resolves to null, same as requestLimits.
function requestSessions() {
  return fetch('/api/sessions/live')
    .then((res) => res.json())
    .then((payload) => (payload && payload.error ? null : payload))
    .catch(() => null);
}

// The suffix of a Live sessions row's Last active cell. Words, not only a colour,
// mark each state: a /clear, any other end, or a response in the last 10 minutes.
function sessionState(s) {
  if (s.ended === 'clear') return ' · cleared';
  if (s.ended) return ' · ended';
  return s.live ? ' · live' : '';
}

// Runs on every loadAndRender, like renderLimits, because "Last active" moves
// with the clock even when the payload does not. Hidden off Today and when no
// session has a snapshot, for example with no statusline hook set up.
function renderSessions(live) {
  const panel = document.getElementById('sessionsPanel');
  panel.hidden = !live || !live.sessions.length || currentDays !== 'today';
  if (panel.hidden) return;

  const now = Date.now();
  const cell = (text, cls) => el('td', cls ? { class: cls, text } : { text });
  const lines = (added, removed) => `+${added} −${removed}`;
  const rows = live.sessions.map((s) => el('tr', {}, [
    // ⬢ for a live session, ⬡ for any other. The Last active cell still says the state in words.
    el('td', {}, [
      el('span', { class: 'session-hex', 'aria-hidden': 'true', text: s.live ? '⬢' : '⬡' }),
      document.createTextNode(s.project || '—'),
    ]),
    cell(s.model || '—'),
    cell(formatCost(s.costUsd), 'num cost'),
    cell(formatDuration(s.durationMs), 'num'),
    cell(formatDuration(s.apiDurationMs), 'num'),
    cell(lines(s.linesAdded, s.linesRemoved), 'num'),
    cell(formatCost(s.costTodayUsd), 'num cost'),
    cell(formatTokens(s.tokens), 'num'),
    cell(formatAgo(s.lastActiveAt, now) + sessionState(s), s.live ? 'is-live' : ''),
  ]));
  const t = live.total;
  rows.push(el('tr', { class: 'sessions-total' }, [
    cell('Total'),
    cell(''),
    cell(formatCost(t.costUsd), 'num cost'),
    // Concurrent sessions overlap, so wall durations do not add up.
    cell('—', 'num'),
    cell(formatDuration(t.apiDurationMs), 'num'),
    cell(lines(t.linesAdded, t.linesRemoved), 'num'),
    cell(formatCost(t.costTodayUsd), 'num cost'),
    cell(formatTokens(t.tokens), 'num'),
    cell(''),
  ]));
  document.getElementById('sessionsTable').replaceChildren(...rows);

  const liveCount = live.sessions.filter((s) => s.live).length;
  const endedCount = live.sessions.filter((s) => s.ended).length;
  const ended = endedCount ? ` · ${endedCount} ended` : '';
  document.getElementById('sessionsNote').textContent =
    `${live.sessions.length} today · ${liveCount} live in the last 10 min${ended} · session figures include earlier days`;
}

// Warn once either window reaches 75%, on every range. Within a window the percent
// only rises, and readLimits() drops a window past its reset, so a stale cache
// understates usage and never raises a false warning. The rounded percent is
// compared so the banner agrees with the "N% used" the panel shows.
const LIMIT_WARN_PERCENT = 75;

// The daily warning fires one point short of the day's budget, so there is room to
// stop before it. It uses the fixed budget, and a weekend has none.
const DAILY_WARN_MARGIN = 1;

function renderLimitsBanner(limits) {
  const banner = document.getElementById('limitsBanner');
  const high = (limits ? limits.limits : []).filter((l) => Math.round(l.percent) >= LIMIT_WARN_PERCENT);
  const today = limits ? limits.today : null;
  const dayHigh = today != null && today.budget != null
    && Math.round(today.share) >= today.budget - DAILY_WARN_MARGIN;
  banner.hidden = !high.length && !dayHigh;
  banner.replaceChildren(
    el('strong', { text: high.length ? 'Nearing your plan limit' : "Nearing today's budget" }),
    ...high.map((l) => el('div', {
      text: `${l.label}: ${Math.round(l.percent)}% used${l.resetsAt == null ? '' : ` · ${formatReset(l.resetsAt)}`}`,
    })),
    ...(dayHigh ? [el('div', { text: `Today: ${Math.round(today.share)}% of the week, budget ${today.budget}%` })] : [])
  );
}

// The Record day card's all-time value. Fetched once on load and once on
// Refresh, not on the 5s live poll or a range switch: /api/records shares the
// days=all cache with /api/summary and /api/changes, so polling it on every
// tick would buy nothing while the cache is warm and force a scan when it
// isn't. A failure resolves to null, same as requestLimits.
function requestRecords() {
  return fetch('/api/records').then((res) => res.json()).catch(() => null);
}

// Kept so /api/records resolving after the first render can redraw the card
// with the same daily data the last summary produced.
let lastRecordDaily = null;
let recordsData = null;

function refreshRecords() {
  requestRecords().then((data) => {
    recordsData = data;
    if (lastRecordDaily) renderRecord(lastRecordDaily);
  });
}

// The value and date line show the all-time record: the day with the most tokens,
// with that day's cost. The note shows the record within the range on screen, also
// with its cost. Today's total grows on every live poll, and the range's scan can
// be newer than the cached all-time scan behind /api/records. So today's total or
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
    shownAllTime ? `${shortDate(shownAllTime.date)} · ${formatCost(shownAllTime.cost)} · all time` : '';

  // On Today the range record is today itself, and Total tokens already shows
  // that number, so the note stays empty.
  let note = '';
  if (currentDays !== 'today' && rangeRecord) {
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
  if (hasDaily) {
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
  if (hasCommands) renderRtkCommands(rtk.commands.filter((c) => c.saved > 0));
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
  const note = document.getElementById('pricesSource');
  const source = await fetch('/api/prices').then((r) => r.json()).catch(() => null);
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

function shortModel(name) {
  // e.g. "claude-sonnet-4-6-20260115" -> "sonnet-4-6"
  const m = name.match(/claude-([a-z]+)-(\d[\d.-]*\d)/i);
  return m ? `${m[1]}-${m[2]}` : name;
}

// #endregion

// #region setup changes

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Shape carries the kind of change, so the marker row reads without colour.
const MARKER_SHAPES = {
  plugin: (x, y) => svgEl('path', { d: `M${x},${y - 5} L${x + 5},${y + 4} L${x - 5},${y + 4} Z` }),
  hook: (x, y) => svgEl('path', { d: `M${x - 5},${y - 4} L${x + 5},${y - 4} L${x},${y + 5} Z` }),
  skill: (x, y) => svgEl('rect', { x: x - 4, y: y - 4, width: 8, height: 8 }),
  'claude-md': (x, y) => svgEl('path', { d: `M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z` }),
  rtk: (x, y) => svgEl('circle', { cx: x, cy: y, r: 4.5 }),
  config: (x, y) => svgEl('path', { d: `M${x - 5},${y} L${x + 5},${y} M${x},${y - 5} L${x},${y + 5} M${x - 3.5},${y - 3.5} L${x + 3.5},${y + 3.5} M${x + 3.5},${y - 3.5} L${x - 3.5},${y + 3.5}` }),
  effort: (x, y) => svgEl('path', { d: `M${x - 4},${y - 4} L${x + 4},${y + 4} M${x + 4},${y - 4} L${x - 4},${y + 4}` }),
  model: (x, y) => svgEl('path', { d: `M${x - 5},${y} L${x + 5},${y} M${x},${y - 5} L${x},${y + 5}` }),
  other: (x, y) => svgEl('path', { d: `M${x - 5},${y} L${x + 5},${y}` }),
};

const MARKER_KIND_NAMES = {
  plugin: 'plugin', hook: 'hook', skill: 'skill', 'claude-md': 'CLAUDE.md', rtk: 'rtk',
  config: 'config', effort: 'effort', model: 'model', other: 'other',
};

// Session dots: shape by model, most-used model first.
const DOT_SHAPES = [
  { square: false, hollow: false },
  { square: false, hollow: true },
  { square: true, hollow: false },
  { square: true, hollow: true },
];

function markerGlyph(kind, x, y) {
  const shape = (MARKER_SHAPES[kind] || MARKER_SHAPES.other)(x, y);
  shape.setAttribute('class', 'marker-glyph');
  return shape;
}

function markerIcon(kind) {
  const svg = svgEl('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true', class: 'marker-icon' });
  svg.appendChild(markerGlyph(kind, 0, 0));
  return svg;
}

function sessionDot(shape, x, y) {
  const node = shape.square
    ? svgEl('rect', { x: x - 3, y: y - 3, width: 6, height: 6 })
    : svgEl('circle', { cx: x, cy: y, r: 3.2 });
  node.setAttribute('class', shape.hollow ? 'session-dot hollow' : 'session-dot');
  return node;
}

function markerDate(t) {
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Local midnight on the Monday of t's week.
function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function dayNoon(dateKey) {
  return new Date(`${dateKey}T12:00`).getTime();
}

// Both charts share one time axis so a marker sits at the same x in each. Built
// from sessions and bashDaily only, not markers: Claude Code deletes transcripts
// after cleanupPeriodDays (30 by default), so history has a sliding start, and a
// plugin or model marker from before the earliest surviving transcript would
// stretch the axis with an empty strip on one side. Markers outside the resulting
// domain are filtered out where each chart draws them (see markerInDomain below).
function timeDomain(report) {
  const times = [
    ...report.sessions.map((s) => s.t),
    ...report.bashDaily.map((d) => dayNoon(d.date)),
  ];
  return [Math.min(...times) - DAY_MS / 2, Math.max(...times) + DAY_MS / 2];
}

// True when a marker falls inside the time axis both charts share. A marker just
// outside it (see timeDomain above) keeps its place in the marker button list but
// draws no glyph, guide, line or shaded window on either chart.
function markerInDomain(marker, domain) {
  return Boolean(marker) && marker.t >= domain[0] && marker.t <= domain[1];
}

function timeScale(domain, width) {
  return (t) => CHART_PAD_LEFT + ((t - domain[0]) / (domain[1] - domain[0])) * (width - CHART_PAD_LEFT);
}

// One label per Monday.
function drawTimeAxis(svg, domain, xOf) {
  const d = new Date(domain[0]);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
  for (; d.getTime() <= domain[1]; d.setDate(d.getDate() + 7)) {
    const label = svgEl('text', { class: 'axis-label', x: xOf(d.getTime()), y: CHART_HEIGHT - 4, 'text-anchor': 'middle' });
    label.textContent = shortDate(localDateStr(d));
    svg.appendChild(label);
  }
}

function withTooltip(node, html) {
  node.addEventListener('mousemove', (evt) => showTooltip(evt, html));
  node.addEventListener('mouseleave', hideTooltip);
  return node;
}

function markerTooltip(m) {
  const source = m.source === 'file' ? 'from changes.json' : `detected from ${m.source === 'plugin' ? 'the plugin list' : 'transcripts'}`;
  return `<strong>${escapeHtml(markerDate(m.t))}</strong><br>${escapeHtml(m.label)}<br>${escapeHtml(source)}`;
}

function modelShapes(sessions) {
  const counts = new Map();
  for (const s of sessions) counts.set(s.model, (counts.get(s.model) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model);
  return new Map(ranked.map((model, i) => [model, DOT_SHAPES[Math.min(i, DOT_SHAPES.length - 1)]]));
}

function drawWeeklyMedian(svg, sessions, domain, xOf, yOf) {
  const weeks = new Map();
  for (const s of sessions) {
    const w = weekStart(s.t);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(s.context);
  }
  let d = '';
  for (const [w, values] of [...weeks].sort((a, b) => a[0] - b[0])) {
    const x1 = xOf(Math.max(w, domain[0]));
    const x2 = xOf(Math.min(w + WEEK_MS, domain[1]));
    const y = yOf(median(values));
    d += `${d ? 'L' : 'M'}${x1},${y} L${x2},${y} `;
    const label = svgEl('text', { class: 'step-label', x: (x1 + x2) / 2, y: y - 6, 'text-anchor': 'middle' });
    label.textContent = axisTokens(Math.round(median(values)));
    svg.appendChild(label);
  }
  svg.appendChild(svgEl('path', { class: 'step-line', d }));
}

// Real value stays in the tooltip even for a dot clamped to the top edge below -
// only its position is capped at the 95th-percentile axis max, not the number shown.
function sessionTooltip(s, max) {
  const offScale = s.context > max ? ' (off the top of the scale)' : '';
  return `<strong>${escapeHtml(markerDate(s.t))}</strong><br>${formatTokens(s.context)} tokens at the first call${offScale}<br>${escapeHtml(s.model || 'unknown model')}`;
}

function drawSessionStartChart(container, report) {
  hideTooltip();
  container.innerHTML = '';
  const { sessions, markers } = report;
  if (!sessions.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No sessions yet.' }));
    return;
  }
  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const domain = timeDomain(report);
  const xOf = timeScale(domain, width);
  const visibleMarkers = markers.filter((m) => markerInDomain(m, domain));

  // A glyph closer than 12px to the one before it stacks one row lower.
  let lastX = -Infinity;
  let row = 0;
  let rows = 1;
  const placed = visibleMarkers.map((m) => {
    const x = xOf(m.t);
    row = x - lastX < 12 ? row + 1 : 0;
    lastX = x;
    rows = Math.max(rows, row + 1);
    return { m, x, row };
  });
  const railTop = CHART_HEIGHT + 12;
  const height = railTop + rows * 13;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, class: 'changes-chart' });
  // The 95th percentile, not the max: one outlier session (a 260,620-token session
  // measured against a typical 38k-52k) otherwise sets the axis top and squashes
  // every ordinary session into the bottom slice of the plot. A dot above the
  // percentile still draws, clamped to the top edge by yOf below.
  const max = drawYAxis(svg, percentile(sessions.map((s) => s.context), 95), width, axisTokens);
  const yOf = (v) => plotHeight - (Math.min(v, max) / max) * plotHeight;
  svg.appendChild(svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)' }));
  drawTimeAxis(svg, domain, xOf);

  for (const { m, x, row: r } of placed) {
    svg.appendChild(svgEl('line', { class: 'marker-guide', x1: x, x2: x, y1: 0, y2: plotHeight }));
    svg.appendChild(withTooltip(markerGlyph(m.kind, x, railTop + r * 13), markerTooltip(m)));
  }

  const shapes = modelShapes(sessions);
  for (const s of sessions) {
    const dot = sessionDot(shapes.get(s.model), xOf(s.t), yOf(s.context));
    svg.appendChild(withTooltip(dot, sessionTooltip(s, max)));
  }
  drawWeeklyMedian(svg, sessions, domain, xOf, yOf);
  container.appendChild(svg);

  const legend = document.getElementById('sessionStartLegend');
  legend.replaceChildren();
  for (const [model, shape] of shapes) {
    const icon = svgEl('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' });
    icon.appendChild(sessionDot(shape, 5, 5));
    legend.appendChild(el('span', { class: 'legend-item' }, [icon, document.createTextNode(model || 'unknown model')]));
  }
  legend.appendChild(el('span', { class: 'legend-item' }, [el('span', { class: 'legend-line step-swatch' }), document.createTextNode('weekly median')]));
  for (const kind of new Set(visibleMarkers.map((m) => m.kind))) {
    legend.appendChild(el('span', { class: 'legend-item' }, [markerIcon(kind), document.createTextNode(MARKER_KIND_NAMES[kind] || kind)]));
  }
}

function drawBashChart(container, report, marker) {
  hideTooltip();
  container.innerHTML = '';
  const days = report.bashDaily;
  if (!days.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'No Bash calls on the main thread yet.' }));
    return;
  }
  const width = chartWidth(container);
  const plotHeight = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const domain = timeDomain(report);
  const xOf = timeScale(domain, width);
  const clampX = (x) => Math.min(width, Math.max(CHART_PAD_LEFT, x));
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${CHART_HEIGHT}`, height: CHART_HEIGHT, class: 'changes-chart' });
  const max = drawYAxis(svg, Math.max(...days.map((d) => d.median)), width, axisTokens);
  const yOf = (v) => plotHeight - (v / max) * plotHeight;
  const barWidth = Math.max(((width - CHART_PAD_LEFT) * DAY_MS) / (domain[1] - domain[0]) * 0.7, 2);

  // A marker outside the shared time axis (see timeDomain) has no "before" this
  // chart's x-axis can place, so it draws no shaded window, line or bar coloring.
  const showMarker = markerInDomain(marker, domain);

  if (showMarker) {
    const b0 = clampX(xOf(marker.t - WEEK_MS));
    const mid = clampX(xOf(marker.t));
    const a1 = clampX(xOf(marker.t + WEEK_MS));
    svg.appendChild(svgEl('rect', { class: 'window-before', x: b0, y: 0, width: mid - b0, height: plotHeight }));
    svg.appendChild(svgEl('rect', { class: 'window-after', x: mid, y: 0, width: a1 - mid, height: plotHeight }));
  }

  for (const d of days) {
    const t = dayNoon(d.date);
    let cls = 'bash-bar';
    if (showMarker && t >= marker.t - WEEK_MS && t < marker.t + WEEK_MS) cls += t >= marker.t ? ' after' : ' before';
    const h = (d.median / max) * plotHeight;
    const rect = svgEl('rect', { class: cls, x: xOf(t) - barWidth / 2, y: plotHeight - h, width: barWidth, height: Math.max(h, 1), rx: 1 });
    svg.appendChild(withTooltip(rect, `<strong>${shortDate(d.date)}</strong><br>median ${formatTokens(Math.round(d.median))} tokens<br>${d.n} Bash calls`));
  }

  if (showMarker) {
    const line = (from, to, value, cls) => {
      if (value == null) return;
      svg.appendChild(svgEl('line', { class: `window-median ${cls}`, x1: clampX(xOf(from)), x2: clampX(xOf(to)), y1: yOf(value), y2: yOf(value) }));
    };
    line(marker.t - WEEK_MS, marker.t, marker.before.bashMedian, 'before');
    line(marker.t, marker.t + WEEK_MS, marker.after.bashMedian, 'after');
    svg.appendChild(svgEl('line', { class: 'marker-line', x1: xOf(marker.t), x2: xOf(marker.t), y1: 0, y2: plotHeight }));
  }
  svg.appendChild(svgEl('line', { x1: CHART_PAD_LEFT, x2: width, y1: plotHeight, y2: plotHeight, stroke: 'var(--border)' }));
  drawTimeAxis(svg, domain, xOf);
  container.appendChild(svg);
}

const tokensCell = (v) => formatTokens(Math.round(v));
const BA_ROWS = [
  { name: 'Session start context', key: 'sessionStart', n: 'sessions', fmt: tokensCell },
  { name: 'Bash result, median', key: 'bashMedian', n: 'bashN', fmt: tokensCell },
  { name: 'Bash result, p90', key: 'bashP90', n: 'bashN', fmt: tokensCell },
  { name: 'Cost per prompt, median', key: 'costPerPrompt', n: 'prompts', fmt: formatCost },
  { name: 'API calls per prompt, median', key: 'callsPerPrompt', n: 'prompts', fmt: (v) => String(Math.round(v * 10) / 10) },
  { name: 'Cache hit rate', key: 'cacheHit', n: 'callN', fmt: formatPercent, points: true },
];
const RTK_ROWS = [
  { name: 'Tokens kept per command', key: 'keptPerCommand', n: 'commands', fmt: tokensCell },
  { name: 'Share of output filtered', key: 'filteredShare', n: 'commands', fmt: formatPercent, points: true },
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

function baRow(row, before, after) {
  const a = before ? before[row.key] : null;
  const b = after ? after[row.key] : null;
  const name = el('td', { text: row.name });
  if (row.n) name.appendChild(el('span', { class: 'n', text: `n ${before ? before[row.n] : 0}→${after ? after[row.n] : 0}` }));
  return el('tr', {}, [
    name,
    el('td', { class: 'num', text: a == null ? '—' : row.fmt(a) }),
    el('td', { class: 'num', text: b == null ? '—' : row.fmt(b) }),
    changeCell(a, b, row.points),
  ]);
}

function renderBeforeAfter(report, marker) {
  const table = document.getElementById('beforeAfterTable');
  const note = document.getElementById('overlapNote');
  table.replaceChildren();
  note.textContent = '';
  if (!marker) return;
  const head = el('tr', {}, ['7 days', 'before', 'after', 'change'].map((text, i) => el('th', { text, class: i ? 'num' : '' })));
  const body = el('tbody', {}, BA_ROWS.map((row) => baRow(row, marker.before, marker.after)));
  if (marker.before.rtk || marker.after.rtk) {
    body.appendChild(el('tr', { class: 'group' }, [el('td', { text: "From rtk's own history", colspan: '4' })]));
    for (const row of RTK_ROWS) body.appendChild(baRow(row, marker.before.rtk, marker.after.rtk));
  }
  table.append(el('thead', {}, [head]), body);

  const near = report.markers.filter((o) => o !== marker && Math.abs(o.t - marker.t) <= WEEK_MS);
  note.textContent = near.length
    ? `${near.length} other change${near.length > 1 ? 's' : ''} in this window: ${near.map((o) => `${markerDate(o.t)} ${o.label}`).join('; ')}. The numbers above cover all of them together.`
    : 'No other change in this window.';
}

const markerKey = (m) => `${m.t}|${m.label}`;
let changesReport = null;
let selectedMarkerKey = null;

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
  drawBashChart(document.getElementById('bashDailyChart'), report, marker);
  renderBeforeAfter(report, marker);
}

function renderChangesFileNote(file) {
  const note = document.getElementById('changesFileNote');
  note.hidden = false;
  note.classList.toggle('changes-error', file.status === 'error');
  if (file.status === 'error') note.textContent = `Couldn't read all of ${file.path}: ${file.error}`;
  else if (file.status === 'missing') note.textContent = `Plugin installs and new models are marked on their own. Add anything else (CLAUDE.md edits, hooks, rtk config) to ${file.path} — the README shows the format.`;
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
  drawSessionStartChart(document.getElementById('sessionStartChart'), report);

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

const CHANGES_CHARTS = ['sessionStartChart', 'bashDailyChart'];

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

// Independent of the range picker, so it loads once and again on Refresh, not on
// every range change.
async function loadChanges() {
  showChangesLoading();
  try {
    const res = await fetch('/api/changes');
    const report = await res.json();
    if (report.error) throw new Error(report.detail || report.error);
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
    handle.addEventListener('pointerdown', () => {
      row.draggable = true;
      document.addEventListener('pointerup', () => { row.draggable = false; }, { once: true });
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
      // needs a redraw. Only the changes charts belong to this row when it's
      // Setup changes (session-start or before/after); other rows' redraw covers
      // only their own charts, via loadAndRender.
      if (!isCollapsed) redrawCharts({ changes: row.id === 'sessionStartPanel' || row.id === 'beforeAfterPanel' });
    });
    headings[0].prepend(toggle);
    setCollapsed(collapsed.has(key));
  }
}

// The Skills and Subagents lists in Where usage goes each collapse to their title.
// They start collapsed from the markup on every load, and the state is not saved.
// The toggles sit outside #skillBars and #subagentBars, which drawUsageBars
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

// #region app state + rendering

let currentDays = 'today';

const LIVE_POLL_MS = 5000;
let liveTimer = null;
// Signature of the last rendered payload. A 5s poll that redraws unconditionally
// would tear down the SVG under the cursor and kill any open tooltip, so an
// unchanged payload skips rendering entirely.
let lastSignature = null;
// Responses can arrive out of order: a 30d scan takes ~1.9s and a today scan ~0.17s,
// so a 30d request issued before a Today click lands after it. Every request takes a
// number, and a response is dropped unless its number is still the newest one.
let requestSeq = 0;

// Time of the last successful summary load, shown as Sync in the status strip.
let lastLoadedAt = null;

// Fills the status strip under the title. loadAndRender calls it on every
// successful summary load, before its unchanged-payload check, so Sync moves on a
// quiet poll too. While live, the ring pulses once per call.
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
  if (!liveTimer) return;
  const ring = document.querySelector('#liveDot .live-ring');
  ring.classList.remove('ping');
  void ring.offsetWidth; // restarts the animation on the next add
  ring.classList.add('ping');
}

function spinnerNode() {
  return el('span', { class: 'spinner', 'aria-hidden': 'true' });
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
  clearInterval(liveTimer);
  liveTimer = on ? setInterval(() => loadAndRender(), LIVE_POLL_MS) : null;
  document.getElementById('liveDot').classList.toggle('is-off', !on);
  document.querySelector('#liveDot .live-text').textContent = on ? 'Link live' : 'Paused';
  // A live range re-scans every 5 seconds, so a manual refresh has nothing to do.
  document.getElementById('refreshBtn').hidden = on;
}

// On Today the summary cards sit in the sticky header in a compact form, so they
// stay in view while scrolling. Other ranges show them as full cards in the page.
// The one #summaryCards element moves between the two slots, so every card id
// stays unique and loadAndRender fills it the same way wherever it is.
function placeSummaryCards() {
  const cards = document.getElementById('summaryCards');
  const today = currentDays === 'today';
  document.getElementById(today ? 'headerCards' : 'mainCards').appendChild(cards);
  cards.classList.toggle('cards-compact', today);
  // Hidden off Today, so the empty slot cannot wrap onto a line of its own.
  document.getElementById('headerCards').hidden = !today;
  // loadAndRender hides these two on Today too, but only once the load finishes.
  // Hiding them here keeps the old range's values out of the header meanwhile.
  if (today) {
    document.getElementById('burnCard').hidden = true;
    document.getElementById('projectionCard').hidden = true;
  }
}

async function loadAndRender({ busy = false } = {}) {
  const banner = document.getElementById('statusBanner');

  const seq = ++requestSeq;

  // Only user-started loads show the busy state. Whichever request is newest
  // clears it when it settles, even a quiet poll, because an older busy request's
  // response is dropped below and would never clear it.
  if (busy) setBusy(true);

  // All three requests are issued before any is awaited, so the summary never
  // waits on rtk or limits. None of the three promises rejects. rtk and limits
  // are optional and resolve to null on failure, so an absent or unreadable source
  // hides its panel. A failed summary resolves to an error payload, which becomes
  // the error banner below after limits have rendered.
  const summaryRequest = fetch(`/api/summary?days=${currentDays}`)
    .then((res) => res.json())
    .catch((err) => ({ error: err.message }));
  const rtkRequest = fetch(`/api/rtk?days=${currentDays}`)
    .then((res) => res.json())
    .then((payload) => (payload && payload.error ? null : payload))
    .catch(() => null);

  const limitsRequest = requestLimits();
  // Only Today shows the panel, so other ranges skip the request and its Today scan.
  const sessionsRequest = currentDays === 'today' ? requestSessions() : Promise.resolve(null);

  const [data, rtk, limits, sessions] = await Promise.all([summaryRequest, rtkRequest, limitsRequest, sessionsRequest]);
  if (seq !== requestSeq) return; // a newer request superseded this response
  setBusy(false);

  // Plan usage describes right now: its "stale" suffix and its reset wording
  // (today vs. a dated form) depend on the clock, not on the fetched numbers, so
  // this has to run on every settled response. That includes one whose summary
  // failed, and one the signature below would otherwise treat as unchanged.
  renderLimits(limits);
  renderSessions(sessions);
  renderLimitsBanner(limits);

  if (data.error) {
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${data.detail || data.error}`;
    lastSignature = null;
    return;
  }

  lastLoadedAt = Date.now();
  renderStatusStrip(data.summary);

  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models, rtk && rtk.summary]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  banner.hidden = true;

  if (!data.meta.dirExists) {
    banner.hidden = false;
    banner.innerHTML = `No Claude Code project logs found at <code>${escapeHtml(data.meta.projectsDir)}</code>. Use Claude Code at least once, or set <code>CLAUDE_CONFIG_DIR</code> if you use a custom location.`;
  } else if (data.meta.scannedFiles === 0) {
    banner.hidden = false;
    banner.textContent = 'Found the projects folder, but no session files yet.';
  }

  const s = data.summary;
  document.getElementById('cardCost').textContent = formatCost(s.totalCost);
  // The compact header card on Today has room for a short note only, so there
  // the full sentence moves to the note's tooltip.
  const unpricedNote = s.unpricedTokens
    ? `${formatTokens(s.unpricedTokens)} tokens from unrecognized models not priced`
    : '';
  const costNote = document.getElementById('cardCostNote');
  const compact = currentDays === 'today';
  costNote.textContent = compact && s.unpricedTokens
    ? `${formatTokens(s.unpricedTokens)} unpriced`
    : unpricedNote;
  costNote.title = compact ? unpricedNote : '';
  document.getElementById('cardTokens').textContent = formatTokens(s.totalTokens);
  document.getElementById('cardCache').textContent = formatPercent(s.cacheEfficiency);

  // Claude Code's own per-session counters, shown as a separate card rather than
  // folded into Total cost. Only present on the all-time range, and only for the
  // sessions that wrote a cost-state line, so it is a floor on what the
  // per-request scan misses, not a replacement total.
  const reportedCard = document.getElementById('reportedCard');
  reportedCard.hidden = s.reportedCost == null;
  if (s.reportedCost != null) {
    document.getElementById('cardReported').textContent = formatCost(s.reportedCost);
    document.getElementById('cardReportedNote').textContent =
      `over ${s.reportedSessions} of ${s.reportedSessionsOf} sessions \u2014 includes calls with no transcript line`;
  }
  document.getElementById('cardFiles').textContent = data.meta.scannedFiles;
  document.getElementById('cardTools').textContent = s.toolCalls.toLocaleString('en-US');
  renderRecord(data.daily);

  drawBarChart(document.getElementById('costChart'), data.daily, {
    color: 'var(--accent-cost)',
    valueKey: 'cost',
    tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatCost(d.cost)}`,
  });

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

  drawCumulativeChart(document.getElementById('cumulativeChart'), data.daily);

  // Hourly buckets on the Today range, where a daily rate has no meaning.
  const perDay = currentDays === 'today' ? null : costPerDay(data.daily);
  document.getElementById('burnCard').hidden = perDay == null;
  document.getElementById('projectionCard').hidden = perDay == null;
  if (perDay != null) {
    document.getElementById('cardBurn').textContent = formatCost(perDay);
    document.getElementById('cardProjection').textContent = formatCost(perDay * 30);
  }

  // Reversed so the legend reads in the order the lines actually appear, cache read
  // at the top down to input at the bottom. TOKEN_SERIES is copied, not reversed in
  // place: the stacked charts rely on its order.
  drawTokenLegend(document.getElementById('tokenTypeLegend'), data.daily, [...TOKEN_SERIES].reverse(), true);
  drawLogLineChart(document.getElementById('tokenTypeChart'), data.daily, TOKEN_SERIES);

  drawModelList(document.getElementById('modelList'), data.models);

  // Every bar in the panel shares one scale. Groups on separate scales made a
  // 30.8% subagent bar draw longer than a 68.2% thread bar.
  const threadRows = [
    { name: 'Main thread', cost: data.threads.main },
    { name: 'Subagents', cost: data.threads.subagent },
  ];
  const contextRows = [
    { name: `Over ${axisTokens(data.contextThreshold)} context`, cost: data.context.over },
    { name: `Under ${axisTokens(data.contextThreshold)} context`, cost: data.context.under },
  ];
  // The two split bars are self-scaling, so only the skill and subagent lists
  // share this one, which is what keeps their lengths comparable to each other.
  const attributionScale = [...data.skills, ...data.subagents].reduce((max, r) => Math.max(max, r.cost), 0);
  const totalCost = data.summary.totalCost;
  document.getElementById('attributionPanel').hidden = totalCost <= 0;
  drawSplitBar(document.getElementById('threadBars'), threadRows);
  drawSplitBar(document.getElementById('contextBars'), contextRows);
  drawUsageBars(document.getElementById('skillBars'), data.skills.slice(0, 8), totalCost, attributionScale);
  drawUsageBars(document.getElementById('subagentBars'), data.subagents.slice(0, 8), totalCost, attributionScale);

  renderTools(data.tools || []);

  drawModelMix(
    document.getElementById('modelMixBar'),
    document.getElementById('modelLegend'),
    data.models
  );

  // An hourly model split is noise, so the over-time view is multi-day only. The mix
  // bar and the Cost by model panel stay on every range, Today included.
  const multiDay = currentDays !== 'today';
  document.getElementById('modelDailyPanel').hidden = !multiDay;
  document.getElementById('modelCostDailyPanel').hidden = !multiDay;
  document.getElementById('activityPanel').hidden = !multiDay;
  if (multiDay) {
    drawModelDailyChart(document.getElementById('modelDailyChart'), data.daily, data.models);
    drawModelDailyChart(document.getElementById('modelCostDailyChart'), data.daily, data.models, 'cost');
    drawActivityHeatmap(document.getElementById('activityHeatmap'), data.activity);
  }

  renderRtk(rtk);
}

document.getElementById('rangePicker').addEventListener('click', (evt) => {
  const btn = evt.target.closest('button[data-days]');
  if (!btn) return;
  document.querySelectorAll('#rangePicker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.days;
  currentDays = value === 'all' || value === 'today' ? value : Number(value);
  placeSummaryCards();
  lastSignature = null; // the bucket keys change, so force a redraw
  setLive(currentDays === 'today');
  loadAndRender({ busy: true });
});

// Everything the Refresh button re-fetches. Applying prices calls it too, because
// costs are computed in the server's scan and the server has just dropped that scan.
function reloadAll() {
  lastSignature = null;
  refreshRecords();
  loadAndRender({ busy: true });
  loadChanges();
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  setBusy(true);
  // A rejected refresh (e.g. the server is down) must not skip loadAndRender below:
  // its failed summary request is what clears busy and shows the error banner.
  await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
  reloadAll();
});

function redrawCharts({ changes = true } = {}) {
  lastSignature = null; // the width changed, so the same data still needs redrawing
  loadAndRender();
  if (changes && changesReport) renderChanges(changesReport);
}

window.addEventListener('resize', () => {
  // Redraw charts on resize so the SVG bars stay full-width (debounced lightly).
  clearTimeout(window.__resizeTimer);
  window.__resizeTimer = setTimeout(redrawCharts, 150);
});

setupRowOrder();
setupCollapsibleRows();
setupPanelLight();
setupUsageGroupToggles();
placeSummaryCards();
setLive(currentDays === 'today');
refreshRecords();
loadAndRender({ busy: true });
loadChanges();
loadPricesSource();

// #endregion
