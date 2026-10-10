// Horizontal bar lists: the skill and subagent lists in Where usage goes, and the
// tool and rtk command lists. Row identity comes from the label, so one fill
// colour is enough and no texture is needed.
import { el, showTooltip, hideTooltip, focusedRowName } from '../dom.mjs';

// What each row shows. size(row) sets the bar's length against the scale, value(row)
// is the text beside the bar, and label(row) is the name cell. The scale runs from
// scaleMin (0 unless a list holds negative values, as the rtk lists can) to
// scaleMax. left and width are percents of the track: a negative bar ends at zero,
// a positive one starts there.
export function barRows(rows, { size, scaleMax, scaleMin = 0, value, label = (row) => row.name }) {
  const span = scaleMax - scaleMin;
  // Written as 0 - scaleMin because -scaleMin is -0 when scaleMin is 0, and -0 is not 0 to deepStrictEqual.
  const zero = span > 0 ? ((0 - scaleMin) / span) * 100 : 0;
  return rows.map((row) => {
    const s = size(row);
    const width = span > 0 ? (Math.abs(s) / span) * 100 : 0;
    return { name: row.name, label: label(row), left: s < 0 ? zero - width : zero, width, value: value(row) };
  });
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
  if (bar.left) fill.style.marginLeft = bar.left + '%';
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
