// Rows of panels move by drag, and the order is saved.
import { el } from '../dom.mjs';
import { ROW_SELECTOR } from './tabs.mjs';

// Each row of panels (a full-width panel or a .panel-row pair) can be moved. The
// order is kept in localStorage as a list of row keys, so the page reopens as it
// was left. A row's key is its first heading's text, stored in data-row-key before
// any control is added to the row. ui/collapse.mjs reads the same key.
// Storage can throw (a private window, blocked site data), and then the page keeps
// the order in index.html.
const ROW_ORDER_KEY = 'cc-dashboard:row-order';

function assignRowKeys() {
  for (const row of document.querySelectorAll(ROW_SELECTOR)) {
    const heading = row.querySelector('.panel-head h2');
    if (heading) row.dataset.rowKey = heading.textContent;
  }
}

const tabs = () => [...document.querySelectorAll('.tab')];
const rowsOf = (tab) => [...tab.querySelectorAll(':scope > .panel-row[data-row-key], :scope > .panel[data-row-key]')];

function panelRows() {
  return tabs().flatMap(rowsOf);
}

// Both tabs' keys, saved as one list.
function currentRowKeys() {
  return panelRows().map((row) => row.dataset.rowKey);
}

function loadRowOrder() {
  try {
    return JSON.parse(localStorage.getItem(ROW_ORDER_KEY));
  } catch {
    return null;
  }
}

function saveRowOrder(keys) {
  try {
    if (keys) localStorage.setItem(ROW_ORDER_KEY, JSON.stringify(keys));
    else localStorage.removeItem(ROW_ORDER_KEY);
  } catch {
    // Not saved. The rows keep their new order for this page view.
  }
}

// The span at the right of a row's first panel head that holds the row's drag handle
// and collapse toggle, before the "x". Keeping them out of the heading starts every
// title at the panel's edge. hidden.mjs moves the span to the panel still showing
// when the first panel of a pair is hidden.
export function rowControls(row) {
  let slot = row.querySelector('.row-controls');
  if (!slot) {
    slot = el('span', { class: 'row-controls' });
    row.querySelector('.panel-head').appendChild(slot);
  }
  return slot;
}

// Re-appends each tab's rows in saved order. orderRowKeys drops the keys of the
// other tab's rows, so the one saved list orders both tabs. defaults pairs each tab
// with its keys in index.html order. The toolbar and the cards come before the
// rows in index.html, so they stay first.
function applyRowOrder(defaults, saved) {
  for (const [tab, keys] of defaults) {
    const byKey = new Map(rowsOf(tab).map((row) => [row.dataset.rowKey, row]));
    for (const key of orderRowKeys(keys, saved)) tab.appendChild(byKey.get(key));
  }
}

function clearDropMarks(row) {
  row.classList.remove('drop-before', 'drop-after');
}

// Adds a handle to each row's controls (rowControls). Pressing the handle makes that row
// draggable, so a drag that starts anywhere else in the row selects text as
// before. The row under the pointer marks the drop point as a line on its top or
// bottom edge, whichever half the pointer is in. onDrop runs after each move.
// The handle's glyph is CSS content, so the handle adds no text.
function setupRowDrag(onDrop) {
  let dragged = null;
  for (const row of panelRows()) {
    const handle = el('span', { class: 'row-handle', title: 'Drag to move', 'aria-hidden': 'true' });
    // A release anywhere clears draggable. Some browsers send a release off the
    // handle to the element under the pointer, so the handle's own listener would miss it.
    // A cancelled pointer (a touch the browser takes over for scrolling, say) sends
    // pointercancel and no pointerup, so either event clears it, and the one
    // AbortController removes both listeners together.
    handle.addEventListener('pointerdown', () => {
      row.draggable = true;
      const release = new AbortController();
      const end = () => {
        row.draggable = false;
        release.abort();
      };
      document.addEventListener('pointerup', end, { signal: release.signal });
      document.addEventListener('pointercancel', end, { signal: release.signal });
    });
    rowControls(row).appendChild(handle);

    // A drag of selected text, a link or an image inside the row targets that
    // element, not the row, so only a drag from the handle moves the row.
    row.addEventListener('dragstart', (e) => {
      if (e.target !== row) return;
      dragged = row;
      row.classList.add('row-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.rowKey);
    });
    // A drag that did not start from a handle, such as a file from the desktop,
    // leaves dragged null, so no row accepts the drop.
    row.addEventListener('dragover', (e) => {
      if (!dragged || dragged === row) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget)) clearDropMarks(row);
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = row.classList.contains('drop-after');
      clearDropMarks(row);
      row.parentNode.insertBefore(dragged, after ? row.nextSibling : row);
      onDrop();
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('row-dragging');
      dragged = null;
    });
  }
}

// Runs before setupCollapsibleRows, which reads data-row-key.
export function setupRowOrder() {
  assignRowKeys();
  const defaults = tabs().map((tab) => [tab, rowsOf(tab).map((row) => row.dataset.rowKey)]);
  const saved = loadRowOrder();
  applyRowOrder(defaults, saved);

  const resetBtn = document.getElementById('resetLayoutBtn');
  resetBtn.hidden = saved == null;
  resetBtn.addEventListener('click', () => {
    applyRowOrder(defaults, null);
    saveRowOrder(null);
    resetBtn.hidden = true;
    document.getElementById('hiddenMenu').hidePopover();
  });

  setupRowDrag(() => {
    saveRowOrder(currentRowKeys());
    resetBtn.hidden = false;
  });
}
