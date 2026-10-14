'use strict';

// Tool use rows written before EXTRACT_VERSION 3 have no `model`. Each takes the
// model of the call with the latest t at or before its own, the later one in array
// order on a tie. A response's lines are contiguous in a file, a call's t is its
// first line, and its tool_use blocks sit on that line or a later one.
// Checked on 2026-10-10 against the model on each block's own line: 63,982 of
// 63,982 tool uses matched. Only the migration from version 2 calls this, so the
// nested loop stays small.
function toolUseModels(rows) {
  const calls = rows.calls.filter((c) => c.t != null).sort((a, b) => a.t - b.t);
  const models = new Map();
  for (const use of rows.toolUses) {
    let model = null;
    for (const c of calls) {
      if (c.t > use.t) break;
      model = c.model;
    }
    models.set(use.key, model);
  }
  return models;
}

module.exports = { toolUseModels };
