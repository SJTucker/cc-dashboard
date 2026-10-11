'use strict';

const test = require('node:test');
const assert = require('node:assert');

const NAMES = ['summary', 'rtk', 'limits', 'sessions', 'reviews'];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Five held requests, and draws that append [name, value] to `log`. `latest.value`
// is what isLatest() returns. Every field of the call can be replaced through `over`.
async function setup(over = {}) {
  const { loadPanels } = await import('../public/load.mjs');
  const held = Object.fromEntries(NAMES.map((name) => [name, deferred()]));
  const log = [];
  const latest = { value: true };
  const call = () => loadPanels({
    requests: Object.fromEntries(NAMES.map((name) => [name, held[name].promise])),
    draws: Object.fromEntries(NAMES.map((name) => [name, (value) => log.push([name, value])])),
    isLatest: () => latest.value,
    reportDrawError: (err) => log.push(['error', err.message]),
    onAllSettled: (values) => log.push(['settled', Object.keys(values).join()]),
    ...over,
  });
  return { held, log, latest, call };
}

test('with the summary held, limits, reviews, sessions and rtk are drawn, and the all-settled step waits', async () => {
  const { held, log, call } = await setup();
  const run = call();

  held.limits.resolve('L');
  held.reviews.resolve('R');
  held.rtk.resolve('T');
  held.sessions.resolve('S');
  await tick();
  assert.deepStrictEqual(log, [['limits', 'L'], ['reviews', 'R'], ['rtk', 'T'], ['sessions', 'S']]);

  held.summary.resolve({ summary: 'ok' });
  const values = await run;
  assert.deepStrictEqual(log.slice(4), [['summary', { summary: 'ok' }], ['settled', 'summary,rtk,limits,sessions,reviews']]);
  assert.deepStrictEqual(values, { summary: { summary: 'ok' }, rtk: 'T', limits: 'L', sessions: 'S', reviews: 'R' });
});

test('a summary that loaded is drawn at once, without waiting for limits', async () => {
  const { held, log, call } = await setup();
  const run = call();

  held.summary.resolve({ summary: 'ok' });
  await tick();
  assert.deepStrictEqual(log, [['summary', { summary: 'ok' }]]);

  for (const name of ['limits', 'reviews', 'sessions', 'rtk']) held[name].resolve(null);
  await run;
});

test('a failed summary draws its banner after limits has drawn', async () => {
  const { held, log, call } = await setup();
  const run = call();

  held.summary.resolve({ error: 'boom', status: 500 });
  await tick();
  assert.deepStrictEqual(log, [], 'the banner waits while limits is still held');

  held.limits.resolve('L');
  await tick();
  assert.deepStrictEqual(log, [['limits', 'L'], ['summary', { error: 'boom', status: 500 }]]);

  for (const name of ['reviews', 'sessions', 'rtk']) held[name].resolve(null);
  await run;
});

test('a response from a superseded load draws nothing, and the all-settled step does not run', async () => {
  const { held, log, latest, call } = await setup();
  const run = call();

  latest.value = false;
  for (const name of NAMES) held[name].resolve(name);

  assert.strictEqual(await run, null);
  assert.deepStrictEqual(log, []);
});

test('a load superseded part way draws what settled before and nothing after', async () => {
  const { held, log, latest, call } = await setup();
  const run = call();

  held.limits.resolve('L');
  await tick();
  latest.value = false;
  for (const name of ['summary', 'rtk', 'sessions', 'reviews']) held[name].resolve(name);

  assert.strictEqual(await run, null);
  assert.deepStrictEqual(log, [['limits', 'L']]);
});

test('a draw that throws is reported, the other panels still draw, and the all-settled step still runs', async () => {
  const { held, log, call } = await setup({
    draws: Object.fromEntries(NAMES.map((name) => [name, (value) => {
      if (name === 'rtk') throw new Error('rtk draw failed');
      if (name === 'summary') throw new Error('summary draw failed');
      log.push([name, value]);
    }])),
  });
  const run = call();
  for (const name of NAMES) held[name].resolve(name);

  await run;

  assert.deepStrictEqual(log.filter(([name]) => name === 'error').map(([, message]) => message).sort(), ['rtk draw failed', 'summary draw failed']);
  assert.deepStrictEqual(log.filter(([name]) => ['limits', 'reviews', 'sessions'].includes(name)).length, 3);
  assert.deepStrictEqual(log[log.length - 1], ['settled', 'summary,rtk,limits,sessions,reviews']);
});
