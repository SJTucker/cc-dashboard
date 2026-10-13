// Rows of panels collapse to their headings, and the Skills and Subagents lists
// collapse to their titles.
import { el } from '../dom.mjs';
import { ROW_SELECTOR } from './tabs.mjs';

// Runs after a row is expanded. Set by setupCollapsibleRows.
let onExpand = () => {};

// Each visual row of panels collapses to its headings. A two-panel row collapses
// as one, and a full-width panel is a row of its own. Collapsed rows are kept in
// localStorage, keyed by data-row-key (see ui/row-order.mjs), so the page
// reopens as it was left. Storage can throw (a private window, blocked site data),
// and then every row starts expanded.
const COLLAPSED_ROWS_KEY = 'cc-dashboard:collapsed-rows';

function loadCollapsedRows() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_ROWS_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveCollapsedRows(keys) {
  try {
    localStorage.setItem(COLLAPSED_ROWS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved. The row still toggles for this page view.
  }
}

export function setupCollapsibleRows(callbacks) {
  ({ onExpand } = callbacks);
  const collapsed = loadCollapsedRows();
  for (const row of document.querySelectorAll(ROW_SELECTOR)) {
    const headings = [...row.querySelectorAll('.panel-head h2')];
    if (!headings.length) continue;
    const key = row.dataset.rowKey;
    const names = headings.map((h) => h.textContent).join(' and ');
    const toggle = el('button', { type: 'button', class: 'row-toggle' });
    const setCollapsed = (isCollapsed) => {
      row.classList.toggle('row-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${names}`);
    };
    toggle.addEventListener('click', () => {
      const isCollapsed = !row.classList.contains('row-collapsed');
      setCollapsed(isCollapsed);
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      saveCollapsedRows(collapsed);
      // A chart drawn while hidden has the 200px fallback width, so an expand
      // needs a redraw (main.mjs).
      if (!isCollapsed) onExpand(row);
    });
    headings[0].prepend(toggle);
    setCollapsed(collapsed.has(key));
  }
}

// The Skills and Subagents lists in Where usage goes each collapse to their title.
// They start collapsed from the markup on every load, and the state is not saved.
// The toggles sit outside #skillBars and #subagentBars, which drawHBars
// rebuilds on every render, so a re-render leaves an open list open.
export function setupUsageGroupToggles() {
  for (const toggle of document.querySelectorAll('#attributionPanel .group-toggle')) {
    const group = toggle.closest('.usage-group');
    toggle.addEventListener('click', () => {
      const isCollapsed = !group.classList.contains('group-collapsed');
      group.classList.toggle('group-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${toggle.dataset.name}`);
    });
  }
}
