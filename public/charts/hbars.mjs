// Horizontal bar lists: the skill and subagent lists in Where usage goes, and the
// tool and rtk command lists. Row identity comes from the label, so one fill
// colour is enough and no texture is needed.
import { el, showTooltip, hideTooltip, focusedRowName } from '../dom.mjs';

// What each row shows. size(row) sets the bar's length against scaleMax, value(row)
// is the text beside the bar, and label(row) is the name cell.
export function barRows(rows, { size, scaleMax, value, label = (row) => row.name }) {
  return rows.map((row) => ({
    name: row.name,
    label: label(row),
    width: scaleMax > 0 ? (size(row) / scaleMax) * 100 : 0,
    value: value(row),
  }));
}

// Draws rows into container. With onSelect, each row is a toggle button and the
// row named selectedName is pressed. The list is rebuilt on every call, so the row
// that had keyboard focus gets it back (focusedRowName).
export function drawHBars(container, rows, options) {
  const refocus = focusedRowName(container);
  container.innerHTML = '';
  if (!rows.length) {
    container.appendChild(el('div', { class: 'bar-empty', text: options.empty }));
    return;
  }
  const bars = barRows(rows, options);
  rows.forEach((row, i) => {
    const node = barNode(row, bars[i], options);
    container.appendChild(node);
    if (refocus !== null && row.name === refocus) node.focus({ preventScroll: true });
  });
}

// Names come from files on disk. el() sets them as text, and each caller's
// tooltip(row) escapes them, because the tooltip is assigned as HTML.
function barNode(row, bar, { tooltip, valueClass = 'usage-pct', onSelect, selectedName }) {
  const fill = el('i');
  fill.style.width = bar.width + '%';
  const selected = row.name === selectedName;
  const node = el('div', { class: 'usage-row' + (onSelect ? ' selectable' : '') + (selected ? ' selected' : '') }, [
    el('span', { class: 'usage-name', text: bar.label, title: row.name }),
    el('span', { class: 'usage-track' }, [fill]),
    el('span', { class: valueClass, text: bar.value }),
  ]);
  node.addEventListener('mousemove', (evt) => showTooltip(evt, tooltip(row)));
  node.addEventListener('mouseleave', hideTooltip);
  if (onSelect) makeSelectable(node, row.name, selected, onSelect);
  return node;
}

function makeSelectable(node, name, selected, onSelect) {
  node.addEventListener('click', () => onSelect(name));
  node.tabIndex = 0;
  node.dataset.name = name;
  // A screen reader hears the row as a toggle button and its pressed state.
  node.setAttribute('role', 'button');
  node.setAttribute('aria-pressed', String(selected));
  node.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      onSelect(name);
    }
  });
}
