'use strict';

// Loaded two ways: index.html loads it as a script before app.js, which makes
// orderRowKeys a global, and the tests load it with require().

// The panel rows' keys in the order to show them. defaultKeys is the order in
// index.html. saved is the list the page stored after the last drag. Saved keys
// with no row are dropped, and a duplicate counts at its first position. A row
// missing from the saved list, such as a new panel or a renamed heading, goes
// directly after the row that precedes it in defaultKeys, or first when nothing
// precedes it. A saved value that is not a list of strings gives defaultKeys.
function orderRowKeys(defaultKeys, saved) {
  if (!Array.isArray(saved) || !saved.every((key) => typeof key === 'string')) return [...defaultKeys];
  const known = new Set(defaultKeys);
  const result = [];
  for (const key of saved) {
    if (known.has(key) && !result.includes(key)) result.push(key);
  }
  defaultKeys.forEach((key, i) => {
    if (result.includes(key)) return;
    // defaultKeys[i - 1] is already in result: it was saved, or placed on the step before.
    const at = i === 0 ? 0 : result.indexOf(defaultKeys[i - 1]) + 1;
    result.splice(at, 0, key);
  });
  return result;
}

if (typeof module === 'object') module.exports = { orderRowKeys };
