'use strict';

// Tool use rows written before EXTRACT_VERSION 3 have no `model`. Each takes the
// model of the call with the latest t at or before its own, the later one in array
// order on a tie. A response's lines are contiguous in a file, a call's t is its
// first line, and its tool_use blocks sit on that line or a later one.
// Checked on 2026-10-10 against the model on each block's own line: 63,982 of
// 63,982 tool uses matched. loadAll runs this at startup for every stored version 2
// row set, including files still on disk. The calls are sorted once and the tool
// uses are walked in t order with one pointer into the calls, so the cost is
// O((calls + tool uses) log n).
function toolUseModels(rows) {
  const calls = rows.calls.filter((c) => c.t != null).sort((a, b) => a.t - b.t);
  const order = rows.toolUses.map((_, i) => i).sort((a, b) => rows.toolUses[a].t - rows.toolUses[b].t);
  const found = new Array(rows.toolUses.length);
  let next = 0;
  let model = null;
  for (const i of order) {
    while (next < calls.length && calls[next].t <= rows.toolUses[i].t) {
      model = calls[next].model;
      next += 1;
    }
    found[i] = model;
  }
  // Set in the tool uses' own order, so the map iterates as it always did.
  const models = new Map();
  rows.toolUses.forEach((use, i) => models.set(use.key, found[i]));
  return models;
}

module.exports = { toolUseModels };
