'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// A tab container's markup: from its opening tag to the next tab's, or to </main>.
function tabMarkup(id) {
  const start = html.indexOf(`<div class="tab" id="${id}"`);
  assert.notEqual(start, -1, `#${id} is missing`);
  const next = html.indexOf('<div class="tab"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('</main>') : next);
}
const panelIds = (markup) => [...markup.matchAll(/<section class="panel"[^>]*?id="(\w+)"/g)].map((m) => m[1]);
const headings = (markup) => [...markup.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

test('the Now tab holds Plan usage and Where usage goes in one row, then Live sessions, the timeline and Models', () => {
  const now = tabMarkup('tabNow');
  assert.deepStrictEqual(panelIds(now), ['limitsPanel', 'attributionPanel', 'sessionsPanel', 'timelinePanel', 'modelsPanel']);
  assert.match(now, /<div class="panel-row even stretch">\s*<section class="panel" id="limitsPanel"/);
});

test('the Now tab row keeps the key Plan usage', () => {
  // assignRowKeys in public/ui/row-order.mjs keys a row by its first heading, so a
  // saved order and a saved collapsed state for Plan usage carry over to the row.
  assert.equal(headings(tabMarkup('tabNow'))[0], 'Plan usage');
});

test('the Analysis tab starts with the range picker and the cards, with no Today button', () => {
  const analysis = tabMarkup('tabAnalysis');
  assert.ok(analysis.indexOf('id="rangePicker"') < analysis.indexOf('id="summaryCards"'));
  assert.ok(analysis.indexOf('id="summaryCards"') < analysis.indexOf('<section class="panel"'));
  assert.doesNotMatch(analysis, /data-days="today"/);
  assert.match(analysis, /<button data-days="7" class="active">/);
});

test('the Analysis cards list the money cards, then the usage cards', () => {
  const cards = tabMarkup('tabAnalysis');
  const keys = [...cards.matchAll(/<div class="card"[^>]*data-hide-key="(card-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['card-cost', 'card-burn', 'card-projection', 'card-reported', 'card-tokens', 'card-cache', 'card-thinking', 'card-tools']);
});

test('the Analysis tab holds the analysis panels in the spec order', () => {
  assert.deepStrictEqual(headings(tabMarkup('tabAnalysis')), [
    'Session reviews',
    'Daily cost', 'Daily tokens',
    'Cumulative cost', 'Daily tokens by type · log', 'Lines of code',
    'Daily tokens by model', 'Daily cost by model',
    'When usage happens',
    'Tool calls',
    'Output rtk kept out of context',
    'What rtk kept out of context',
    'Setup changes &middot; before and after',
  ]);
});

test('the header has the tab switch, and the Analysis tab starts hidden', () => {
  assert.match(html, /<div class="tab-switch" id="tabSwitch"/);
  assert.match(html, /<div class="tab" id="tabAnalysis" hidden>/);
});

test('Models is one panel on the Now tab, last, that keeps the Cost by model hide key, and the donut is gone', () => {
  assert.match(html, /<section class="panel" id="modelsPanel" data-hide-key="costByModel">/);
  assert.ok(panelIds(tabMarkup('tabNow')).at(-1) === 'modelsPanel');
  assert.doesNotMatch(html, /modelMixPanel|modelMixChart/);
  assert.match(html, /<div class="mix-measure" id="mixMeasure"/);
});

test('the header has a High scores tab and its container starts hidden', () => {
  assert.match(html, /<button[^>]*data-tab="highscores"[^>]*>High scores<\/button>/);
  assert.match(html, /<div class="tab" id="tabHighscores" hidden>\s*<section class="arcade" id="arcade"><\/section>/);
});
