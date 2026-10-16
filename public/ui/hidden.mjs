// Any panel or summary card can be hidden, and shown again from the ☰ menu.
import { el } from '../dom.mjs';
import { state } from '../state.mjs';
import { parseHidden, neededRequests } from '../visibility.mjs';

// Set by setupHiding. onWidthChange runs after one panel of a pair is hidden;
// onResume runs after panels are shown (see showKeys).
let onWidthChange = () => {};
let onResume = () => {};

// Any panel or summary card can be hidden with its "x" button and shown again
// from the ☰ menu in the header. The hidden keys (data-hide-key in index.html)
// are kept in localStorage. A hidden element gets data-user-hidden, which
// css/base.css hides with !important, so a renderer setting `panel.hidden = false`
// cannot show it. Storage can throw (a private window, blocked site data), and
// then nothing starts hidden.
const HIDDEN_KEY = 'cc-dashboard:hidden';

function loadHidden() {
  try {
    return new Set(parseHidden(localStorage.getItem(HIDDEN_KEY)));
  } catch {
    return new Set();
  }
}

function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hiddenKeys]));
  } catch {
    // Not saved. The change holds for this page view.
  }
}

// The name in the menu and in the "x" button's label: the panel's heading or the
// card's label. The row handle and toggle sit outside the heading and add no text.
function hideName(element) {
  const label = element.querySelector('.panel-head h2, .card-label');
  return label ? label.textContent.trim() : element.dataset.hideKey;
}

// A row's handle and toggle sit in its first panel head (rowControls in
// row-order.mjs). When the first panel of a pair is hidden, by the user or by its
// renderer, they move to the head of the panel still showing, before its "x", and
// back when the first panel returns.
function placeRowControls(row, panel) {
  const head = panel.querySelector(':scope > .panel-head');
  const slot = row.querySelector('.row-controls');
  if (head && slot && slot.parentElement !== head) head.insertBefore(slot, head.querySelector(':scope > .hide-btn'));
}

// The panel whose head holds a row's handle and toggle: the first panel showing,
// else the first panel. A panel is not showing when the user hid it
// (data-user-hidden) or its renderer hid it (hidden). Reads only those two, so the
// tests can pass plain objects.
export function controlsPanel(panels) {
  return panels.find((panel) => !panel.hidden && !panel.hasAttribute('data-user-hidden')) || panels[0];
}

function applyHidden() {
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    element.toggleAttribute('data-user-hidden', state.hiddenKeys.has(element.dataset.hideKey));
  }
  for (const row of document.querySelectorAll('.tab > .panel-row')) {
    const panels = [...row.querySelectorAll(':scope > .panel')];
    const visible = panels.filter((panel) => !panel.hasAttribute('data-user-hidden'));
    row.toggleAttribute('data-user-hidden', visible.length === 0);
    placeRowControls(row, controlsPanel(panels));
  }
  renderHiddenMenu();
}

function hideKey(key) {
  state.hiddenKeys.add(key);
  saveHidden();
  applyHidden();
  const element = document.querySelector(`[data-hide-key="${key}"]`);
  // The other panel of a pair widens to the full row, so its SVG needs a redraw at the new width.
  if (element && element.closest('.panel-row')) onWidthChange();
}

// A hidden panel was not drawn, so showing one draws it. resumed(request) is true
// for a request that was skipped because all its panels were hidden and that is
// needed now. onResume decides what to load again.
function showKeys(keys) {
  const before = neededRequests(state.hiddenKeys, state.tab);
  for (const key of keys) state.hiddenKeys.delete(key);
  saveHidden();
  applyHidden();
  const after = neededRequests(state.hiddenKeys, state.tab);
  onResume((request) => after.has(request) && !before.has(request));
}

// An element on the tab being shown, or on no tab. Showing a hidden panel of the
// other tab would change nothing on screen, so the menu lists only this tab's.
// Reads only closest() and `hidden`, so the tests can pass plain objects.
export function onShownTab(element) {
  return !element.closest('.tab')?.hidden;
}

// One button per hidden element on the tab being shown, in page order, then Show all
// when two or more are listed. Choosing one closes the menu, and the popover returns
// focus to ☰. Reset layout (row-order.mjs) sits below the list. The menu is drawn
// again each time it opens (setupHiding), so it follows the tab.
function renderHiddenMenu() {
  const menu = document.getElementById('hiddenMenuList');
  const hidden = [...document.querySelectorAll('[data-hide-key][data-user-hidden]')].filter(onShownTab);
  menu.replaceChildren();
  if (!hidden.length) {
    menu.appendChild(el('p', { class: 'hidden-menu-empty', text: 'Nothing hidden on this tab' }));
    return;
  }
  const choose = (keys) => {
    document.getElementById('hiddenMenu').hidePopover();
    showKeys(keys);
  };
  for (const element of hidden) {
    const name = hideName(element) + (element.classList.contains('card') ? ' · card' : '');
    const item = el('button', { type: 'button', class: 'hidden-menu-item', text: name });
    item.addEventListener('click', () => choose([element.dataset.hideKey]));
    menu.appendChild(item);
  }
  if (hidden.length >= 2) {
    const all = el('button', { type: 'button', class: 'hidden-menu-item hidden-menu-all', text: 'Show all' });
    all.addEventListener('click', () => choose(hidden.map((element) => element.dataset.hideKey)));
    menu.appendChild(all);
  }
}

// Adds the "x" to each panel's head and each card, and places the menu under ☰
// each time it opens. Hiding moves focus to ☰, because the focused "x" has just
// disappeared with its panel.
export function setupHiding(callbacks) {
  ({ onWidthChange, onResume } = callbacks);
  state.hiddenKeys = loadHidden();
  const menuBtn = document.getElementById('hiddenMenuBtn');
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    const name = hideName(element);
    const btn = el('button', { type: 'button', class: 'hide-btn', 'aria-label': `Hide ${name}`, title: `Hide ${name}`, text: '×' });
    btn.addEventListener('click', () => {
      hideKey(element.dataset.hideKey);
      menuBtn.focus();
    });
    (element.querySelector(':scope > .panel-head') || element).appendChild(btn);
  }
  const menu = document.getElementById('hiddenMenu');
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    renderHiddenMenu();
    const box = menuBtn.getBoundingClientRect();
    menu.style.top = `${box.bottom + 6}px`;
    menu.style.right = `${document.documentElement.clientWidth - box.right}px`;
  });
  applyHidden();
  // Renderers set `hidden` on their own panels (renderLimits, renderNowPanels,
  // renderAttribution), and applyHidden does not run then. One observer per pair
  // moves the handle and toggle whenever a panel in it is hidden or shown.
  for (const row of document.querySelectorAll('.tab > .panel-row')) {
    const panels = [...row.querySelectorAll(':scope > .panel')];
    const observer = new MutationObserver(() => placeRowControls(row, controlsPanel(panels)));
    for (const panel of panels) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }
}
