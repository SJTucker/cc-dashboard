// Two shares of one whole as a single split bar.
import { el, showTooltip, hideTooltip } from '../dom.mjs';
import { formatCost, escapeHtml } from '../format.mjs';
import { textureCss, TOKENS } from './palette.mjs';

// Two shares of one whole, drawn as a single split bar. Main-thread vs subagent
// and over- vs under-threshold context are both partitions of total cost, so the
// pair reads better as one bar than as two the eye has to add up. The skill and
// subagent lists (drawHBars) are not partitions - one call can appear in both - so
// they keep the separate-bar form.
//
// Both shares in the one non-money series colour. Texture tells them apart: the
// larger part solid, the smaller part diagonal. The direct labels carry identity too.
const SPLIT_STYLE = [
  { color: TOKENS.seriesNeutral, texture: 'solid' },
  { color: TOKENS.seriesNeutral, texture: 'diag' },
];

// Styles follow size, not list position: the rows sorted by cost, largest first,
// so the larger part is the solid one whichever order the caller passes.
export function sortSplitRows(rows) {
  return [...rows].sort((a, b) => b.cost - a.cost);
}

export function drawSplitBar(container, rows) {
  container.innerHTML = '';
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  if (!(total > 0)) {
    container.appendChild(el('div', { class: 'bar-empty', text: 'Nothing attributed in this range.' }));
    return;
  }

  const bar = el('div', { class: 'mix-bar' });
  const legend = el('div', { class: 'legend split-legend' });

  sortSplitRows(rows).forEach((row, i) => {
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
