// A long list shows its first rows and a button that shows the rest in place. No
// panel scrolls inside the page. Nothing here runs at load time.
import { el } from '../dom.mjs';

// The rows to draw: all of them when expanded or when they fit in limit.
export function visibleRows(rows, limit, expanded) {
  return expanded || rows.length <= limit ? rows : rows.slice(0, limit);
}

// "Show all (n)", or "Show fewer" once expanded, or null when the rows fit. The
// caller flips its own expanded flag in onToggle and redraws.
export function showAllButton(total, limit, expanded, onToggle) {
  if (total <= limit) return null;
  const button = el('button', {
    type: 'button',
    class: 'show-all',
    'aria-expanded': String(expanded),
    text: expanded ? 'Show fewer' : `Show all (${total})`,
  });
  button.addEventListener('click', onToggle);
  return button;
}

// The redraw a click starts rebuilds the button, so focus moves to the new one.
export function refocusShowAll(containerId) {
  document.querySelector(`#${containerId} .show-all`)?.focus({ preventScroll: true });
}
