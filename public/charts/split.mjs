// Two shares of one whole as a single split bar.
import { el, showTooltip, hideTooltip } from '../dom.mjs';
import { formatCost, escapeHtml } from '../format.mjs';
import { textureCss, TOKENS } from './palette.mjs';
import { legendRow, swatchIcon } from './legend.mjs';

// Two shares of one whole, drawn as a single split bar. Main-thread vs subagent
// and over- vs under-threshold context are both partitions of total cost, so the
// pair reads better as one bar than as two the eye has to add up. The skill and
// subagent lists (drawHBars) are not partitions - one call can appear in both - so
// they keep the separate-bar form.
//
// Both shares in cyan, the colour of the Plan usage meters beside them. Texture
// tells them apart: the larger part solid, the smaller part diagonal. The direct
// labels carry identity too.
const SPLIT_STYLE = [
  { color: TOKENS.accentCyan, texture: 'solid' },
  { color: TOKENS.accentCyan, texture: 'diag' },
];

// Styles follow size, not list position: the rows sorted by cost, largest first,
// so the larger part is the solid one whichever order the caller passes.
export function sortSplitRows(rows) {
  return [...rows].sort((a, b) => b.cost - a.cost);
}

// Shares of one whole as a single bar, with its legend under it. items is
// [{ name, value, texture, color, tooltip }], drawn in the order given. extra holds
// legend items with no segment, such as unpriced models.
export function drawShareBar(container, items, { empty, extra = [] }) {
  container.replaceChildren();
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!(total > 0)) {
    container.appendChild(el('div', { class: 'bar-empty', text: empty }));
    return;
  }
  const pct = (item) => (item.value / total) * 100;
  const bar = el('div', { class: 'mix-bar' });
  for (const item of items) {
    const seg = el('div', { class: 'mix-seg', style: `width:${pct(item)}%;background:${textureCss(item.texture, item.color)}` });
    seg.addEventListener('mousemove', (evt) => showTooltip(evt, item.tooltip));
    seg.addEventListener('mouseleave', hideTooltip);
    bar.appendChild(seg);
  }
  const legend = legendRow([
    ...items.map((item) => ({ icon: swatchIcon(item.texture, item.color), label: item.name, value: `${pct(item).toFixed(1)}%` })),
    ...extra,
  ]);
  container.append(bar, legend);
}

// Main thread against subagents, or over against under the context threshold: two
// parts of total cost. rows is [{ name, cost }]. Sorted by cost so the larger part
// is the solid one, and the legend follows the bar's order.
export function drawSplitBar(container, rows) {
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  const share = (cost) => (total > 0 ? ((cost / total) * 100).toFixed(1) : '0.0');
  drawShareBar(container, sortSplitRows(rows).map((row, i) => ({
    name: row.name,
    value: row.cost,
    ...SPLIT_STYLE[i % SPLIT_STYLE.length],
    tooltip: `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${share(row.cost)}% of total`,
  })), { empty: 'Nothing attributed in this range.' });
}
