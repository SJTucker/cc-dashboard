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

// Runs draw, which replaces the children of #containerId. When keyboard focus was
// inside the container, it moves to the rebuilt Show all button. A poll redraw
// destroys the focused button the same way a click's redraw does.
export function keepShowAllFocus(containerId, draw) {
  const hadFocus = document.getElementById(containerId)?.contains(document.activeElement);
  draw();
  if (hadFocus) refocusShowAll(containerId);
}

// The redraw a click starts rebuilds the button, so focus moves to the new one.
export function refocusShowAll(containerId) {
  document.querySelector(`#${containerId} .show-all`)?.focus({ preventScroll: true });
}
