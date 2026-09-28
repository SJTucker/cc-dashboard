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

// Mirrors localDateStr in lib/scan.js so the front end can tell which bucket is
// today without parsing a locale-formatted string.
function localDateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Average cost per COMPLETE day. Today is excluded because it is partial and
// would drag the average down. The divisor is the calendar span between the
// first and last complete bucket, not the bucket count: a day with no usage
// produces no bucket at all, and ignoring those would overstate the rate.
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

function showTooltip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const x = evt.clientX + 14;
  const y = evt.clientY + 14;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
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
    const labelEvery = Math.ceil(data.length / 12);
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

    const labelEvery = Math.ceil(points.length / 12);
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

const TEXTURE_INK = '#10141b';

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

    const labelEvery = Math.ceil(data.length / 12);
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

    const labelEvery = Math.ceil(data.length / 12);
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

    const labelEvery = Math.ceil(data.length / 12);
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
const HEAT_RGB = '234, 181, 77';

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

function drawTokenLegend(container, data, series = TOKEN_SERIES, lineStyle = false) {
  container.innerHTML = '';
  for (const ser of series) {
    const total = (data || []).reduce((sum, d) => sum + (d[ser.key] || 0), 0);

    container.appendChild(
      el('span', { class: 'legend-item' }, [
        lineStyle
          ? el('span', {
              class: 'legend-line',
              style: `border-top:2px ${ser.dash ? 'dashed' : 'solid'} ${ser.color}`,
            })
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

function drawToolBars(container, rows, scaleMax, onSelect, selectedName) {
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
      node.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          onSelect(row.name);
        }
      });
    }
    container.appendChild(node);
  }
}

// Same two-column shape as drawToolBars, but scaled by tokens saved rather than by
// call count, because "which commands is rtk helping with" is a question about
// tokens. A command with 15,000 cheap calls and one with 127 expensive ones both
// show up honestly this way.
function drawRtkBars(container, rows, scaleMax, onSelect, selectedName) {
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
      node.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          onSelect(row.name);
        }
      });
    }
    container.appendChild(node);
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

// Claude Code only refreshes its usage cache while it runs. /usage itself stops
// trusting cached bars after 60 minutes, so the panel says so past that age.
const LIMITS_STALE_MS = 60 * 60 * 1000;

// Plan usage describes right now, not a date range. The panel shows only on
// Today, and the 75% warning banner shows on every range. Like rtk it is
// optional: a failure resolves to null and hides both.
function requestLimits() {
  return fetch('/api/limits').then((res) => res.json()).catch(() => null);
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
  const asOf = new Date(limits.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stale = Date.now() - limits.fetchedAt > LIMITS_STALE_MS
    ? ' — may be stale: Claude Code updates it while a session runs'
    : '';
  document.getElementById('limitsNote').textContent = `from Claude Code's usage cache, as of ${asOf} (${zone})${stale}`;
}

// Warn once either window reaches 75%, on every range. Within a window the percent
// only rises, and readLimits() drops a window past its reset, so a stale cache
// understates usage and never raises a false warning. The rounded percent is
// compared so the banner agrees with the "N% used" the panel shows.
const LIMIT_WARN_PERCENT = 75;

function renderLimitsBanner(limits) {
  const banner = document.getElementById('limitsBanner');
  const high = (limits ? limits.limits : []).filter((l) => Math.round(l.percent) >= LIMIT_WARN_PERCENT);
  banner.hidden = !high.length;
  banner.replaceChildren(
    el('strong', { text: 'Nearing your plan limit' }),
    ...high.map((l) => el('div', {
      text: `${l.label}: ${Math.round(l.percent)}% used${l.resetsAt == null ? '' : ` · ${formatReset(l.resetsAt)}`}`,
    }))
  );
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
      const perMillion = m.tokens > 0 ? m.cost / (m.tokens / 1e6) : 0;
      const share = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
      return `<tr>
        <td class="model-name"><span class="swatch" style="${segmentTexture(m.family)}"></span>${escapeHtml(m.model)}</td>
        <td class="num">${formatTokens(m.tokens)}</td>
        <td class="num cost-cell">${formatCost(m.cost)}</td>
        <td class="num">${share.toFixed(1)}%</td>
        <td class="num">${formatCost(perMillion)}</td>
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

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank, mirroring percentile() in lib/efficiency.js: always a value that
// occurred.
function percentileOf(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
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
    const y = yOf(medianOf(values));
    d += `${d ? 'L' : 'M'}${x1},${y} L${x2},${y} `;
    const label = svgEl('text', { class: 'step-label', x: (x1 + x2) / 2, y: y - 6, 'text-anchor': 'middle' });
    label.textContent = axisTokens(Math.round(medianOf(values)));
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
  const max = drawYAxis(svg, percentileOf(sessions.map((s) => s.context), 95), width, axisTokens);
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
  // A live range re-scans every 5 seconds, so a manual refresh has nothing to do.
  document.getElementById('refreshBtn').hidden = on;
}

async function loadAndRender({ busy = false } = {}) {
  const banner = document.getElementById('statusBanner');

  const seq = ++requestSeq;

  // Only user-started loads show the busy state. Whichever request is newest
  // clears it when it settles, even a quiet poll, because an older busy request's
  // response is dropped below and would never clear it.
  if (busy) setBusy(true);

  // Both requests are issued before either is awaited, so the summary never waits
  // on the rtk read. Awaiting them in sequence put two optional panels on the
  // critical path of every card and chart on the page.
  //
  // rtk is optional, so its promise swallows its own failures and resolves to null
  // rather than rejecting: an absent or unreadable rtk database hides those two
  // panels, and must not blank the dashboard with an error banner.
  const summaryRequest = fetch(`/api/summary?days=${currentDays}`).then((res) => res.json());
  const rtkRequest = fetch(`/api/rtk?days=${currentDays}`)
    .then((res) => res.json())
    .then((payload) => (payload && payload.error ? null : payload))
    .catch(() => null);

  const limitsRequest = requestLimits();

  let data;
  let rtk;
  let limits;
  try {
    [data, rtk, limits] = await Promise.all([summaryRequest, rtkRequest, limitsRequest]);
    if (data.error) throw new Error(data.detail || data.error);
  } catch (err) {
    if (seq !== requestSeq) return;
    setBusy(false);
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${err.message}`;
    lastSignature = null;
    return;
  }

  if (seq !== requestSeq) return; // a newer request superseded this response
  setBusy(false);

  // Plan usage describes right now: its "stale" suffix and its reset wording
  // (today vs. a dated form) depend on the clock, not on the fetched numbers, so
  // this has to run on every settled response, even one the signature below
  // would otherwise treat as unchanged and skip.
  renderLimits(limits);
  renderLimitsBanner(limits);

  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models, rtk && rtk.summary]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  banner.hidden = true;

  document.getElementById('projectsDirLabel').textContent = data.meta.projectsDir;

  if (!data.meta.dirExists) {
    banner.hidden = false;
    banner.innerHTML = `No Claude Code project logs found at <code>${escapeHtml(data.meta.projectsDir)}</code>. Use Claude Code at least once, or set <code>CLAUDE_CONFIG_DIR</code> if you use a custom location.`;
  } else if (data.meta.scannedFiles === 0) {
    banner.hidden = false;
    banner.textContent = 'Found the projects folder, but no session files yet.';
  }

  const s = data.summary;
  document.getElementById('cardCost').textContent = formatCost(s.totalCost);
  document.getElementById('cardCostNote').textContent = s.unpricedTokens
    ? `${formatTokens(s.unpricedTokens)} tokens from unrecognized models not priced`
    : '';
  document.getElementById('cardTokens').textContent = formatTokens(s.totalTokens);
  document.getElementById('cardCache').textContent = formatPercent(s.cacheEfficiency);

  // Claude Code's own per-session counters, shown beside Total cost rather than
  // folded into it. Only present on the all-time range, and only for the
  // sessions that wrote a cost-state line, so it is a floor on what the
  // per-request scan misses, not a replacement total.
  const reportedCard = document.getElementById('reportedCard');
  reportedCard.hidden = s.reportedCost == null;
  if (s.reportedCost != null) {
    document.getElementById('cardReported').textContent = formatCost(s.reportedCost);
    document.getElementById('cardReportedNote').textContent =
      `over ${s.reportedSessions} of ${s.sessions} sessions \u2014 includes calls with no transcript line`;
  }
  document.getElementById('cardFiles').textContent = data.meta.scannedFiles;
  document.getElementById('cardSessions').textContent = s.sessions.toLocaleString('en-US');
  document.getElementById('cardTools').textContent = s.toolCalls.toLocaleString('en-US');

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
  lastSignature = null; // the bucket keys change, so force a redraw
  setLive(currentDays === 'today');
  loadAndRender({ busy: true });
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  setBusy(true);
  await fetch('/api/refresh', { method: 'POST' });
  lastSignature = null;
  loadAndRender({ busy: true });
  loadChanges();
});

window.addEventListener('resize', () => {
  // Redraw charts on resize so the SVG bars stay full-width (debounced lightly).
  clearTimeout(window.__resizeTimer);
  window.__resizeTimer = setTimeout(() => {
    lastSignature = null; // width changed, so the same data still needs redrawing
    loadAndRender();
    if (changesReport) renderChanges(changesReport);
  }, 150);
});

setLive(currentDays === 'today');
loadAndRender({ busy: true });
loadChanges();

// #endregion
