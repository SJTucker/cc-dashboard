'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/settings-switch.mjs');
const fake = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('saveSettings returns the backlog count on 409', async () => {
  const { saveSettings } = await load();
  assert.deepStrictEqual(await saveSettings({ reviews: true }, fake(409, { error: 'backlog', backlog: 3 })), { ok: false, backlog: 3 });
});

test('saveSettings returns the detail text on 500', async () => {
  const { saveSettings } = await load();
  const r = await saveSettings({ reviews: false }, fake(500, { error: 'Failed to save the settings', detail: 'disk full' }));
  assert.deepStrictEqual(r, { ok: false, error: 'disk full' });
});

test('saveSettings returns the saved settings on 200', async () => {
  const { saveSettings } = await load();
  const r = await saveSettings({ reviews: true }, fake(200, { reviews: true, setupLabels: true }));
  assert.deepStrictEqual(r, { ok: true, settings: { reviews: true, setupLabels: true } });
});

test('saveSettings falls back to the HTTP status, then a thrown message', async () => {
  const { saveSettings } = await load();
  assert.deepStrictEqual(await saveSettings({}, fake(502, null)), { ok: false, error: 'HTTP 502' });
  assert.deepStrictEqual(await saveSettings({}, async () => { throw new Error('offline'); }), { ok: false, error: 'offline' });
});

test('backlogText says "1 session" for one', async () => {
  const { backlogText } = await load();
  assert.match(backlogText(1), /^1 session ended in the last 7 days while suggestions were off\./);
  assert.match(backlogText(4), /^4 sessions ended/);
});

test('the Haiku labels switch keeps its saved state across a redraw of the cached report', async () => {
  const { installDom } = require('./dom-stub');
  installDom();
  const nodes = {};
  const get = (id) => (nodes[id] ??= Object.assign(document.createElement('div'), { checked: true, hidden: false, classList: { toggle() {}, add() {} }, dataset: {}, style: {} }));
  document.getElementById = get;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ reviews: true, setupLabels: false }) };
    return { ok: true, status: 200, json: async () => ({ markers: [], sessions: [{ t: Date.now() }], daily: new Proxy({}, { get: () => [] }), labelsOn: true, changesFile: { status: 'ok' } }) };
  };
  try {
    const changes = await import('../public/panels/changes.mjs');
    const { wireLabelsSwitch } = await load();
    const state = (await import('../public/state.mjs')).state;
    state.hiddenKeys = new Set(); state.tab = 'analysis';
    await changes.loadChanges();
    assert.strictEqual(get('labelsSwitch').checked, true);
    let onChange;
    get('labelsSwitch').addEventListener = (_type, fn) => { onChange = fn; };
    wireLabelsSwitch();
    get('labelsSwitch').checked = false;
    await onChange();
    changes.redrawChanges();
    assert.strictEqual(get('labelsSwitch').checked, false);
  } finally { globalThis.fetch = realFetch; }
});
