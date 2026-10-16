// Page state that more than one module reads. A module that changes a value
// assigns the property, because a module cannot reassign an imported binding.
export const state = {
  // The range the page loads: 'today' on the Now tab, 'highscores' on the High
  // scores tab (no range summary loads), else state.analysisDays.
  currentDays: 'today',
  // The tab shown: 'now', 'analysis' or 'highscores' (public/ui/tabs.mjs).
  // currentDays is 'today' on Now and analysisDays on Analysis. Panels and requests
  // that belong to a tab key on this, because Analysis can be on 'today' too.
  tab: 'now',
  // The range picked on the Analysis tab: 'today', 7, 30, 90 or 'all'.
  analysisDays: 'today',
  // The data-hide-key values (index.html) of the hidden panels and cards.
  // Filled from localStorage when the page starts.
  hiddenKeys: new Set(),
  // The Models share bar's measure: 'tokens' or 'cost'. setupModelMixToggle (panels/models.mjs) fills it from localStorage when the page starts.
  mixMeasure: 'tokens',
};

export const shown = (key) => !state.hiddenKeys.has(key);
