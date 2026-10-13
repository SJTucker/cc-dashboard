// The one legend pattern: a row of items under a plot. Each item is an icon drawn
// like the mark it explains, a short label and an optional value. A longer
// explanation goes in the item's title, which the browser shows on hover.
import { el, svgEl } from '../dom.mjs';
import { textureCss } from './palette.mjs';

function legendItem({ icon, label, value, title }) {
  const parts = [icon, el('span', { class: 'legend-label', text: label })];
  if (value) parts.push(el('span', { class: 'legend-value', text: value }));
  return el('span', title ? { class: 'legend-item', title } : { class: 'legend-item' }, parts);
}

// items: [{ icon, label, value?, title? }]. cls adds classes, such as 'side-legend'.
export function legendRow(items, cls = '') {
  return el('div', { class: cls ? `legend ${cls}` : 'legend' }, items.map(legendItem));
}

// A fill sample: the series' texture over its colour, as the charts paint it.
export function swatchIcon(texture, color) {
  return el('span', { class: 'legend-swatch', style: `background:${textureCss(texture, color)}`, 'aria-hidden': 'true' });
}

// A line sample in the series' colour and dash. It is 28px wide: that holds a
// whole '9 4 2 4' cycle and the start of the next. At 16px, '9 4 2 4' looked the
// same as '9 4'.
export function lineIcon(color, dash) {
  const svg = svgEl('svg', { class: 'legend-line', width: 28, height: 4, viewBox: '0 0 28 4', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('line', {
    x1: 0, y1: 2, x2: 28, y2: 2, stroke: color, 'stroke-width': 2,
    ...(dash ? { 'stroke-dasharray': dash } : {}),
  }));
  return svg;
}

// A 12px icon holding SVG nodes drawn around 0,0, for marks copied from a chart,
// such as the timeline's arrowhead or a rebuild diamond.
export function glyphIcon(...nodes) {
  const svg = svgEl('svg', { class: 'legend-glyph', width: 12, height: 12, viewBox: '-6 -6 12 12', 'aria-hidden': 'true' });
  for (const node of nodes) svg.appendChild(node);
  return svg;
}
