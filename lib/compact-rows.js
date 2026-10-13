'use strict';

// Shrinks the rows lib/extract.js produces for the copy held in memory. A call row
// carries the whole raw `usage` object, and the aggregate reads seven of its fields.
// Equal strings (session id, model, version, tool name) are also shared, so 61k
// calls hold one string per distinct value.
//
// Compaction applies to rows in memory only. The database keeps the full `usage`,
// because it is the only copy once Claude Code deletes a transcript. Call this from
// lib/store.js loadAll() and from lib/rowstore.js persist() after its transaction.
// Never call it before store.put(), and never from lib/extract.js.

// The usage fields lib/aggregate.js, lib/pricing.js costForUsage() and
// cacheWriteTokens() read. `speed` matters only as 'fast'. lib/aggregate.js also
// reads output_tokens_details.thinking_tokens, which slimUsage copies on its own.
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const SPLIT_KEYS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'];

function slimUsage(usage) {
  if (usage === null || typeof usage !== 'object') return usage;
  const slim = {};
  for (const key of TOKEN_KEYS) if (usage[key] !== undefined) slim[key] = usage[key];
  const split = usage.cache_creation;
  if (split && typeof split === 'object') {
    slim.cache_creation = {};
    for (const key of SPLIT_KEYS) if (split[key] !== undefined) slim.cache_creation[key] = split[key];
  }
  if (usage.speed === 'fast') slim.speed = 'fast';
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (thinking !== undefined) slim.output_tokens_details = { thinking_tokens: thinking };
  return slim;
}

// Mutates and returns `rows`. `intern` maps a string to the one instance kept for
// it, and a store passes the same map for every row set so strings are shared
// across files. A row set that failed to extract has nothing to compact.
function compactRows(rows, intern = new Map()) {
  if (!rows || !rows.ok) return rows;
  const share = (s) => {
    if (typeof s !== 'string') return s;
    const held = intern.get(s);
    if (held !== undefined) return held;
    intern.set(s, s);
    return s;
  };
  // A key a row lacks stays absent, so a stored row keeps the shape it had.
  const shareKeys = (row, keys) => {
    for (const key of keys) if (key in row) row[key] = share(row[key]);
  };
  for (const call of rows.calls) {
    if ('usage' in call) call.usage = slimUsage(call.usage);
    shareKeys(call, ['sessionId', 'model', 'version', 'attributionSkill', 'attributionAgent', 'agentId']);
    if (Array.isArray(call.tools)) call.tools = call.tools.map(share);
  }
  for (const use of rows.toolUses) {
    // Tool uses of version 2 rows have no `model`, and lib/aggregate.js tests
    // `'model' in use`. shareKeys leaves an absent key absent.
    shareKeys(use, ['name', 'detail', 'model']);
  }
  for (const list of [rows.edits, rows.prompts, rows.errors]) {
    for (const row of list) shareKeys(row, ['sessionId']);
  }
  return rows;
}

module.exports = { slimUsage, compactRows };
