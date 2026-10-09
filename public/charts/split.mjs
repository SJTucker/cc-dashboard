// Two shares of one whole as a single split bar.
import { el, showTooltip, hideTooltip } from '../dom.mjs';
import { formatCost, escapeHtml } from '../format.mjs';
import { textureCss } from './palette.mjs';

// Two shares of one whole, drawn as a single split bar. Main-thread vs subagent
// and over- vs under-threshold context are both partitions of total cost, so the
// pair reads better as one bar than as two the eye has to add up. The skill and
// subagent lists (drawHBars) are not partitions - one call can appear in both - so
// they keep the separate-bar form.
//
// Validated with the dataviz skill's validate_palette.js against the panel
// surface: CVD deltaE 27.3 (protan). Texture and the direct labels carry identity;
// colour is secondary, as everywhere else here.
const SPLIT_STYLE = [
  { color: '#c98500', texture: 'solid' },
  { color: '#9085e9', texture: 'diag' },
];

export function drawSplitBar(container, rows) {
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
