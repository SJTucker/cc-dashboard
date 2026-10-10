// Page state that more than one module reads. A module that changes a value
// assigns the property, because a module cannot reassign an imported binding.
export const state = {
  // The range picker's value: 'today', 7, 30, 90 or 'all'.
  currentDays: 'today',
  // The data-hide-key values (index.html) of the hidden panels and cards.
  // Filled from localStorage when the page starts.
  hiddenKeys: new Set(),
  // The Model mix donut's measure: 'tokens' or 'cost'. setupModelMixToggle
  // (panels/models.mjs) fills it from localStorage when the page starts.
  mixMeasure: 'tokens',
};

export const shown = (key) => !state.hiddenKeys.has(key);
