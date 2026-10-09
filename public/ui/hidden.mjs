// Any panel or summary card can be hidden, and shown again from the ☰ menu.
import { el } from '../dom.mjs';
import { state } from '../state.mjs';

// Set by setupHiding. onWidthChange runs after one panel of a pair is hidden;
// onResume runs after panels are shown (see showKeys).
let onWidthChange = () => {};
let onResume = () => {};

// Any panel or summary card can be hidden with its "x" button and shown again
// from the ☰ menu in the header. The hidden keys (data-hide-key in index.html)
// are kept in localStorage. A hidden element gets data-user-hidden, which
// style.css hides with !important, so a renderer setting `panel.hidden = false`
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
// card's label. The row handle and toggle in a heading add no text.
function hideName(element) {
  const label = element.querySelector('.panel-head h2, .card-label');
  return label ? label.textContent.trim() : element.dataset.hideKey;
}

// setupRowDrag and setupCollapsibleRows put a row's handle and toggle in its first
// heading. When the first panel of a pair is hidden, they move to the heading of
// the panel still showing, and back when the first panel returns.
function placeRowControls(row, panel) {
  const heading = panel.querySelector(':scope > .panel-head > h2');
  const toggle = row.querySelector(':scope > .panel > .panel-head > h2 > .row-toggle');
  const handle = row.querySelector(':scope > .panel > .panel-head > h2 > .row-handle');
  if (heading && toggle && toggle.parentElement !== heading) heading.prepend(...[toggle, handle].filter(Boolean));
}

function applyHidden() {
  for (const element of document.querySelectorAll('[data-hide-key]')) {
    element.toggleAttribute('data-user-hidden', state.hiddenKeys.has(element.dataset.hideKey));
  }
  for (const row of document.querySelectorAll('#app > .panel-row')) {
    const panels = [...row.querySelectorAll(':scope > .panel')];
    const visible = panels.filter((panel) => !panel.hasAttribute('data-user-hidden'));
    row.toggleAttribute('data-user-hidden', visible.length === 0);
    placeRowControls(row, visible[0] || panels[0]);
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
  const before = neededRequests(state.hiddenKeys, state.currentDays);
  for (const key of keys) state.hiddenKeys.delete(key);
  saveHidden();
  applyHidden();
  const after = neededRequests(state.hiddenKeys, state.currentDays);
  onResume((request) => after.has(request) && !before.has(request));
}

// One button per hidden element, in page order, then Show all when two or more
// are hidden. Choosing one closes the menu, and the popover returns focus to ☰.
function renderHiddenMenu() {
  const menu = document.getElementById('hiddenMenu');
  const hidden = [...document.querySelectorAll('[data-hide-key][data-user-hidden]')];
  menu.replaceChildren();
  if (!hidden.length) {
    menu.appendChild(el('p', { class: 'hidden-menu-empty', text: 'Nothing hidden' }));
    return;
  }
  const choose = (keys) => {
    menu.hidePopover();
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
    const box = menuBtn.getBoundingClientRect();
    menu.style.top = `${box.bottom + 6}px`;
    menu.style.right = `${document.documentElement.clientWidth - box.right}px`;
  });
  applyHidden();
}
