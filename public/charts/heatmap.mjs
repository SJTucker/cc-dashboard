// Cost by weekday and hour.
import { el, showTooltip, hideTooltip } from '../dom.mjs';
import { formatCost, formatTokens } from '../format.mjs';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --accent-cost as RGB, so cell intensity can be expressed as an alpha without
// color-mix. Keep in sync with --accent-cost in public/style.css.
const HEAT_RGB = '255, 176, 0';

// One hue varying only in opacity. Magnitude is carried by lightness alone,
// which is why this needs no texture channel the way the categorical charts do.
export function drawActivityHeatmap(container, activity) {
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
