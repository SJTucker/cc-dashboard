// Cost by weekday and hour.
import { el, showTooltip, hideTooltip } from '../dom.mjs';
import { formatCost, formatTokens } from '../format.mjs';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HEAT_FLOOR = 0.12;

// A cell's opacity: its cost against the busiest cell's. The floor keeps the
// cheapest non-zero hour visible against an idle one.
export function heatAlpha(cost, max) {
  return cost > 0 && max > 0 ? HEAT_FLOOR + (1 - HEAT_FLOOR) * (cost / max) : 0;
}

// The scale under the grid: five steps from the cheapest non-zero cell to the
// busiest, or null when no cell cost anything.
export function heatScale(costs) {
  const spent = costs.filter((c) => c > 0);
  if (!spent.length) return null;
  const low = Math.min(...spent);
  const high = Math.max(...spent);
  return { low, high, alphas: [0, 1, 2, 3, 4].map((i) => heatAlpha(low + ((high - low) * i) / 4, high)) };
}

const heatFill = (alpha) => `color-mix(in srgb, var(--money-fill) ${Math.round(alpha * 100)}%, transparent)`;

// One hue, --money-fill, varying only in opacity, because the cells measure cost.
// Magnitude is carried by lightness alone, so this needs no texture channel the way
// the categorical charts do. The scale row names the two ends.
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
        cell.style.background = heatFill(heatAlpha(c.cost, max));
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

  const scale = heatScale(activity.map((c) => c.cost));
  container.appendChild(el('div', { class: 'legend heat-scale' }, [
    el('span', { class: 'legend-value', text: formatCost(scale.low) }),
    el('span', { class: 'heat-scale-cells', 'aria-hidden': 'true' },
      scale.alphas.map((a) => el('span', { class: 'heat-scale-cell', style: `background:${heatFill(a)}` }))),
    el('span', { class: 'legend-value', text: formatCost(scale.high) }),
  ]));
}
