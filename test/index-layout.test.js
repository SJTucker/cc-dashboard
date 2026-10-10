'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// The markup from the row that holds #limitsPanel up to #timelinePanel, the panel
// after it. Null when #limitsPanel is not inside a .panel-row.
function planUsageRow() {
  const start = html.lastIndexOf('<div class="panel-row', html.indexOf('id="limitsPanel"'));
  return start === -1 ? null : html.slice(start, html.indexOf('id="timelinePanel"'));
}

test('Plan usage and Where usage goes are the two panels of one even, stretched row', () => {
  const row = planUsageRow();
  assert.ok(row, '#limitsPanel is not inside a .panel-row');
  assert.match(row, /^<div class="panel-row even stretch">/);
  const ids = [...row.matchAll(/<section class="panel" id="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ['limitsPanel', 'attributionPanel']);
  // The row closes before #timelinePanel.
  assert.strictEqual((row.match(/<div[\s>]/g) || []).length, (row.match(/<\/div>/g) || []).length);
});

test('the row keeps the key Plan usage', () => {
  // assignRowKeys in public/ui/row-order.mjs keys a row by its first heading, so a
  // saved order and a saved collapsed state for Plan usage carry over to the row.
  const row = planUsageRow();
  assert.ok(row, '#limitsPanel is not inside a .panel-row');
  assert.strictEqual(row.match(/<h2[^>]*>([^<]*)<\/h2>/)[1], 'Plan usage');
});
