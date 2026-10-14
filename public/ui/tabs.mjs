// The two tabs. Now holds Plan usage, Where usage goes, the timeline and Live
// sessions, always on the Today range. Analysis holds everything else, on the range
// picked there. The tab is the URL hash, so reload, Back and a bookmark keep it.
// Nothing here touches the DOM at load time (test/modules-load.test.js).
export const TABS = ['now', 'analysis'];

// Every panel row in either tab: a full-width panel or a .panel-row pair.
export const ROW_SELECTOR = '.tab > .panel-row, .tab > .panel';

// The tab a hash names. An empty or unknown hash is Now.
export function tabFromHash(hash) {
  const name = String(hash ?? '').replace(/^#/, '');
  return TABS.includes(name) ? name : 'now';
}

// The range a tab loads. Now is always Today. Analysis keeps the range last picked
// on it in this page view.
export function rangeForTab(tab, analysisDays) {
  return tab === 'now' ? 'today' : analysisDays;
}

// The panels each tab draws from the summary (drawSummaryPanels in main.mjs). The
// other tab's panels are hidden, so drawing them would put the wrong range's
// numbers in them and size their charts at the 200px fallback width.
const SUMMARY_PANELS = {
  now: ['attribution', 'models'],
  analysis: ['cards', 'usage', 'modelDaily', 'tools'],
};

export function summaryPanelsFor(tab) {
  return SUMMARY_PANELS[tab] ?? SUMMARY_PANELS.now;
}

const CONTAINER_IDS = { now: 'tabNow', analysis: 'tabAnalysis' };

// Shows the tab's container, hides the other, and presses the tab's button.
export function showTab(tab) {
  for (const name of TABS) document.getElementById(CONTAINER_IDS[name]).hidden = name !== tab;
  for (const btn of document.querySelectorAll('#tabSwitch button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.tab === tab));
  }
}

// A tab button sets the hash, and the hash change switches the tab. So a click, a
// typed URL and Back all go through onSwitch. onSwitch(tab) also runs once now, for
// the hash the page opened with. A page opened with no valid hash gets "#now" through
// replaceState, which adds no history entry and fires no hashchange. Without that,
// the first click on Now would change the hash from "" to "#now" and load the tab a
// second time. A click on the tab already shown sets the same hash, which fires no
// hashchange, so nothing reloads.
export function setupTabs(onSwitch) {
  for (const btn of document.querySelectorAll('#tabSwitch button')) {
    btn.addEventListener('click', () => {
      location.hash = btn.dataset.tab;
    });
  }
  const tab = tabFromHash(location.hash);
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  window.addEventListener('hashchange', () => onSwitch(tabFromHash(location.hash)));
  onSwitch(tab);
}
