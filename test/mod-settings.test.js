'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

const load = () => import('../public/panels/mod-settings.mjs');
const ALL = { handoff: 'document', transcriptIndex: true, reviews: true, setupMarkers: true, setupLabels: true, activity: true, limitBand: true };
const KEYS = ['handoff', 'transcriptIndex', 'reviews', 'setupMarkers', 'setupLabels', 'activity', 'limitBand'];

function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}
const find = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };

function setup() {
  installDom();
  const status = document.createElement('p');
  status.hidden = true;
  document.getElementById = (id) => (id === 'modSettingsStatus' ? status : null);
  return { container: document.createElement('div'), status };
}

test('renderModSettings draws one row per setting in order', async () => {
  const { renderModSettings } = await load();
  const { container } = setup();
  renderModSettings(container, ALL);
  const rows = find(container, (n) => n.className === 'mod-row');
  assert.deepStrictEqual(rows.map((r) => r.attributes.id), KEYS.map((k) => `modSetting-${k}`));
  assert.ok(rows.every((r) => r.attributes.tabindex === '-1'));
});

test('handoff row checks the saved choice', async () => {
  const { renderModSettings } = await load();
  const { container } = setup();
  renderModSettings(container, { ...ALL, handoff: 'transcript' });
  const radios = find(container, (n) => n.attributes.type === 'radio' && n.attributes.name === 'modSetting-handoff');
  assert.deepStrictEqual(radios.map((r) => r.attributes.value), ['document', 'transcript', 'off']);
  assert.deepStrictEqual(radios.map((r) => r.checked), [false, true, false]);
});

test('on/off rows draw an On and an Off segment that reflect the saved boolean', async () => {
  const { renderModSettings } = await load();
  const { container } = setup();
  renderModSettings(container, { ...ALL, activity: false });
  const radios = find(container, (n) => n.attributes.type === 'radio' && n.attributes.name === 'modSetting-activity');
  assert.deepStrictEqual(radios.map((r) => r.attributes.value), ['true', 'false']);
  assert.deepStrictEqual(radios.map((r) => r.checked), [false, true]);
  const groups = find(container, (n) => n.className === 'segmented');
  assert.strictEqual(groups.length, 7, 'every row, handoff included, uses the segmented control');
});

test('each row has an info popover with the Design copy', async () => {
  const { renderModSettings } = await load();
  const { container } = setup();
  renderModSettings(container, ALL);
  for (const key of KEYS) {
    const button = find(container, (n) => n.attributes.popovertarget === `modInfo-${key}`);
    const pop = find(container, (n) => n.attributes.id === `modInfo-${key}`);
    assert.strictEqual(button.length, 1, key);
    assert.strictEqual(pop.length, 1, key);
    assert.ok('popover' in pop[0].attributes, key);
  }
  const handoff = find(container, (n) => n.attributes.id === 'modInfo-handoff')[0].textContent;
  assert.match(handoff, /one model call per idle gap/);
  assert.match(handoff, /Transcript and index/);
});

test('each row has an Affects line', async () => {
  const { renderModSettings } = await load();
  const { container } = setup();
  renderModSettings(container, ALL);
  const lines = find(container, (n) => n.className === 'mod-affects').map((n) => n.textContent);
  assert.strictEqual(lines.length, 7);
  assert.ok(lines.every((l) => l.startsWith('Affects: ')));
});

test('renderModSettings disables controls on a load error', async () => {
  const { renderModSettings } = await load();
  const { container, status } = setup();
  renderModSettings(container, { error: 'HTTP 404' });
  assert.strictEqual(status.hidden, false);
  assert.strictEqual(status.textContent, 'Could not load the mod settings: HTTP 404');
  const inputs = find(container, (n) => n.tagName === 'input');
  assert.ok(inputs.length >= 8);
  assert.ok(inputs.every((i) => i.disabled === true));
});

test('a successful render hides the status line', async () => {
  const { renderModSettings } = await load();
  const { container, status } = setup();
  status.hidden = false;
  renderModSettings(container, ALL);
  assert.strictEqual(status.hidden, true);
});
