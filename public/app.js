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
function axisCost(usd) {
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'k';
  return '$' + usd.toFixed(usd < 1 ? 2 : 0);
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

const TOKEN_SERIES = [
  { key: 'input', label: 'Input', color: '#c98500', texture: 'diag' },
  { key: 'output', label: 'Output', color: '#3987e5', texture: 'diag-rev' },
  { key: 'cacheCreate', label: 'Cache write', color: '#d55181', texture: 'dots' },
  { key: 'cacheRead', label: 'Cache read', color: '#9085e9', texture: 'solid' },
];

// Cache read is ~97-98% of all tokens, so it gets its own panel. Stacked with the
// others it leaves them at sub-pixel heights whatever the scale, which is what made
// their textures pointless.
const CACHE_READ_SERIES = TOKEN_SERIES.filter((s) => s.key === 'cacheRead');
const WORKING_TOKEN_SERIES = TOKEN_SERIES.filter((s) => s.key !== 'cacheRead');

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
//
// The two token panels deliberately share the 'token' scope. That is safe only
// because CACHE_READ_SERIES and WORKING_TOKEN_SERIES partition TOKEN_SERIES, so no
// texture+colour pair appears in both. Keep that true if you move a series between
// them, or give each panel its own scope string.
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

// Same geometry as drawStackedChart, but the segments are models rather than token
// types. Series order is fixed across buckets so a model keeps its vertical position
// and its colour from day to day. mode picks whether the segments measure tokens or
// dollars; the two differ sharply because an Opus token costs five Haiku tokens.
function drawModelDailyChart(container, data, models, mode = 'tokens') {
  const source = mode === 'cost' ? 'costByModel' : 'byModel';
  const axisFmt = mode === 'cost' ? axisCost : axisTokens;
  const tipFmt = mode === 'cost' ? formatCost : (n) => formatTokens(n) + ' tokens';
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
  appendPatternDefs(svg, 'model', order.map((f) => ({ texture: modelTexture(f), color: modelColor(f) })));
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
        fill: fillFor('model', modelTexture(name), modelColor(name)),
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

function drawTokenLegend(container, data, series = TOKEN_SERIES) {
  container.innerHTML = '';
  for (const ser of series) {
    const total = (data || []).reduce((sum, d) => sum + (d[ser.key] || 0), 0);

    container.appendChild(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: `background:${textureCss(ser.texture, ser.color)}` }),
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

function drawModelList(container, models) {
  container.innerHTML = '';
  if (!models.length) {
    container.appendChild(el('div', { class: 'list-empty', text: 'No priced usage in this range.' }));
    return;
  }
  const max = Math.max(...models.map((m) => m.cost), 0.0001);
  for (const m of models) {
    const pct = Math.max((m.cost / max) * 100, 2);
    const row = el('div', { class: 'model-row' }, [
      el('span', { class: 'model-name', text: shortModel(m.model) }),
      el('div', { class: 'model-bar-track' }, [
        el('div', { class: 'model-bar-fill', style: `width:${pct}%` }),
      ]),
      el('span', { class: 'model-cost', text: formatCost(m.cost) }),
    ]);
    container.appendChild(row);
  }
}

function shortModel(name) {
  // e.g. "claude-sonnet-4-6-20260115" -> "sonnet-4-6"
  const m = name.match(/claude-([a-z]+)-(\d[\d.-]*\d)/i);
  return m ? `${m[1]}-${m[2]}` : name;
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

function setLive(on) {
  clearInterval(liveTimer);
  liveTimer = on ? setInterval(loadAndRender, LIVE_POLL_MS) : null;
  document.getElementById('liveDot').classList.toggle('is-off', !on);
}

async function loadAndRender() {
  const banner = document.getElementById('statusBanner');

  const seq = ++requestSeq;

  let data;
  try {
    const res = await fetch(`/api/summary?days=${currentDays}`);
    data = await res.json();
    if (data.error) throw new Error(data.detail || data.error);
  } catch (err) {
    if (seq !== requestSeq) return;
    banner.hidden = false;
    banner.textContent = `Couldn't load usage data: ${err.message}`;
    lastSignature = null;
    return;
  }

  if (seq !== requestSeq) return; // a newer request superseded this response

  const signature = JSON.stringify([data.meta, data.summary, data.daily, data.models]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  banner.hidden = true;

  document.getElementById('projectsDirLabel').textContent = data.meta.projectsDir;

  if (!data.meta.dirExists) {
    banner.hidden = false;
    banner.innerHTML = `No Claude Code project logs found at <code>${data.meta.projectsDir}</code>. Use Claude Code at least once, or set <code>CLAUDE_CONFIG_DIR</code> if you use a custom location.`;
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
  document.getElementById('cardFiles').textContent = data.meta.scannedFiles;

  drawBarChart(document.getElementById('costChart'), data.daily, {
    color: 'var(--accent-cost)',
    valueKey: 'cost',
    tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatCost(d.cost)}`,
  });

  drawTokenLegend(document.getElementById('cacheReadLegend'), data.daily, CACHE_READ_SERIES);
  drawStackedChart(document.getElementById('cacheReadChart'), data.daily, CACHE_READ_SERIES);

  drawTokenLegend(document.getElementById('workingTokenLegend'), data.daily, WORKING_TOKEN_SERIES);
  drawStackedChart(document.getElementById('workingTokenChart'), data.daily, WORKING_TOKEN_SERIES);

  drawModelList(document.getElementById('modelList'), data.models);

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
  if (multiDay) {
    drawModelDailyChart(document.getElementById('modelDailyChart'), data.daily, data.models);
    drawModelDailyChart(document.getElementById('modelCostDailyChart'), data.daily, data.models, 'cost');
  }
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
  loadAndRender();
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  await fetch('/api/refresh', { method: 'POST' });
  lastSignature = null;
  loadAndRender();
});

window.addEventListener('resize', () => {
  // Redraw charts on resize so the SVG bars stay full-width (debounced lightly).
  clearTimeout(window.__resizeTimer);
  window.__resizeTimer = setTimeout(() => {
    lastSignature = null; // width changed, so the same data still needs redrawing
    loadAndRender();
  }, 150);
});

setLive(currentDays === 'today');
loadAndRender();

// #endregion
