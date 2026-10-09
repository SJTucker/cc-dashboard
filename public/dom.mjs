// DOM building blocks shared by the charts and panels. Nothing here runs at load
// time, so node can import this module (test/modules-load.test.js).

// The one tooltip element in index.html, looked up per call so this module does
// not touch the DOM when it loads.
const tooltipNode = () => document.getElementById('tooltip');

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// The tooltip is measured after its content is set, so tooltipPosition can keep
// the whole of it inside the viewport.
export function showTooltip(evt, html) {
  const tooltip = tooltipNode();
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pos = tooltipPosition(evt.clientX, evt.clientY, tooltip.offsetWidth, tooltip.offsetHeight, innerWidth, innerHeight);
  tooltip.style.left = pos.left + 'px';
  tooltip.style.top = pos.top + 'px';
}

export function hideTooltip() {
  const tooltip = tooltipNode();
  tooltip.hidden = true;
}

// Keyboard focus has no mouse position, so the tooltip is placed at the focused
// element's bounding box.
export function withFocusTooltip(node, html) {
  node.addEventListener('focus', () => {
    const rect = node.getBoundingClientRect();
    showTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.bottom }, html);
  });
  node.addEventListener('blur', hideTooltip);
  return node;
}

export function withTooltip(node, html) {
  node.addEventListener('mousemove', (evt) => showTooltip(evt, html));
  node.addEventListener('mouseleave', hideTooltip);
  return node;
}

export function chartWidth(container) {
  return Math.max(container.clientWidth, 200);
}

// The name of the row in container that has keyboard focus, or null. A list
// rebuild on a selection or a live poll drops focus to <body>, so the list
// builders call this first and refocus the row with the same name afterwards.
export function focusedRowName(container) {
  const active = document.activeElement;
  return active && active !== container && container.contains(active) ? active.dataset.name || null : null;
}

export function spinnerNode() {
  return el('span', { class: 'spinner', 'aria-hidden': 'true' });
}
