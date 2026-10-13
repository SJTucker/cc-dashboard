// The four token types on a log axis, and the token legend.
import { el, svgEl, showTooltip, hideTooltip, chartWidth } from '../dom.mjs';
import { formatTokens, shortDate, fullDate, axisTokens } from '../format.mjs';
import { CHART_HEIGHT, CHART_PAD_LEFT, CHART_PAD_BOTTOM } from './axes.mjs';
import { TOKEN_SERIES } from './palette.mjs';
import { legendRow, lineIcon } from './legend.mjs';

// Daily tokens for all four types in one plot. The four span six orders of
// magnitude on a typical range - 78 input tokens against 452M cache reads - which
// a linear axis cannot show: input and output sit below one pixel. A log axis can,
// but it rules out bars, because a bar's length is measured from zero and a log
// axis has no zero, and stacked segments do not add in log space. So the marks are
// lines. Read it for the gaps between the lines (cache read runs ~400x output) and
// for each line's slope, not for area.
export function drawLogLineChart(container, data, series = TOKEN_SERIES) {
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

// The side legend of the token-type chart: a dash sample, the label and the
// range total per series, in the order the lines run top to bottom.
export function drawTokenLegend(container, data, series = TOKEN_SERIES) {
  const items = series.map((ser) => {
    const total = (data || []).reduce((sum, d) => sum + (d[ser.key] || 0), 0);
    return { icon: lineIcon(ser.color, ser.dash), label: ser.label, value: total ? formatTokens(total) : '' };
  });
  container.replaceChildren(legendRow(items, 'side-legend'));
}
