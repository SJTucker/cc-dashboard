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

test('saveSetting posts one key', async () => {
  const { saveSetting } = await load();
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ activity: false }) }; };
  const r = await saveSetting('activity', false, { fetchImpl });
  assert.deepStrictEqual(sent, { url: '/api/settings', body: { activity: false } });
  assert.deepStrictEqual(r, { ok: true, settings: { activity: false } });
});

test('saveSetting asks about the backlog when turning reviews on', async () => {
  const { saveSetting } = await load();
  const bodies = [];
  const answers = [{ status: 409, body: { error: 'backlog', backlog: 3 } }, { status: 200, body: { reviews: true } }];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const a = answers.shift();
    return { ok: a.status === 200, status: a.status, json: async () => a.body };
  };
  const asked = [];
  const r = await saveSetting('reviews', true, { fetchImpl, ask: async (n) => { asked.push(n); return 'skip'; } });
  assert.deepStrictEqual(asked, [3]);
  assert.deepStrictEqual(bodies, [{ reviews: true }, { reviews: true, backlog: 'skip' }]);
  assert.strictEqual(r.ok, true);
});

test('saveSetting reports cancelled when the backlog dialog is cancelled', async () => {
  const { saveSetting } = await load();
  const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ error: 'backlog', backlog: 2 }) });
  assert.deepStrictEqual(await saveSetting('reviews', true, { fetchImpl, ask: async () => null }), { ok: false, cancelled: true });
});
