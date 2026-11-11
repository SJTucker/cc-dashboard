'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/orchestration/render.mjs');

test('statusView gives every status a glyph and a word', async () => {
  const { statusView } = await load();
  for (const s of ['working', 'quiet', 'starting', 'stuck', 'done', 'review', 'passed', 'changes', 'merged']) {
    const v = statusView(s);
    assert.ok(v.glyph && v.word, s);
  }
  assert.equal(statusView('stuck').tone, 'warn');
  assert.equal(statusView('working').tone, 'live');
  assert.equal(statusView('merged').tone, 'plain');
});

test('switcherState words follow waiting, phase and liveness', async () => {
  const { switcherState } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(switcherState({ waiting: true, phase: 'waves', wave: 2, live: true }, now), 'Waiting for you');
  assert.equal(switcherState({ waiting: false, phase: 'waves', wave: 2, live: true }, now), 'Wave 2');
  assert.equal(switcherState({ phase: 'plan', live: true }, now), 'Planning');
  assert.equal(switcherState({ phase: 'reset', live: true }, now), 'Reset');
  assert.equal(switcherState({ phase: 'finish', live: false, lastActiveAt: now - 3 * 3600_000 }, now), 'Finished 3h ago');
  assert.equal(switcherState({ phase: 'finish', live: false, lastActiveAt: now - 20_000 }, now), 'Finished just now');
  assert.equal(switcherState({ phase: 'waves', wave: null, live: true }, now), 'Waves');
});

test('meterRatio is tokens over the 120000 budget, clamped to 1', async () => {
  const { meterRatio } = await load();
  assert.equal(meterRatio(60000), 0.5);
  assert.equal(meterRatio(130000), 1);
  assert.equal(meterRatio(null), 0);
});

test('phaseSteps marks earlier steps done and the current one now', async () => {
  const { phaseSteps } = await load();
  assert.deepEqual(phaseSteps('waves', true).map((s) => s.state), ['done', 'done', 'now', 'todo']);
  assert.deepEqual(phaseSteps('finish', false).map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(phaseSteps('plan', true).map((s) => s.name), ['Plan', 'Reset', 'Waves', 'Finish']);
});

test('countsLine lists only the non-zero counts', async () => {
  const { countsLine } = await load();
  assert.equal(countsLine({ working: 2, review: 0, merged: 1, attention: 0 }), '2 working · 1 merged');
  assert.equal(countsLine({ working: 0, review: 0, merged: 0, attention: 0 }), 'no workers yet');
});

test('postTime reads as minutes ago under an hour and as a 24-hour clock after', async () => {
  const { postTime } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(postTime(new Date(now - 4 * 60_000).toISOString(), now), '4m ago');
  assert.equal(postTime(new Date(now - 10_000).toISOString(), now), 'just now');
  assert.match(postTime(new Date(now - 3 * 3600_000).toISOString(), now), /^\d\d:\d\d$/);
});

test('reviewLabel says Reviewer running for a running review', async () => {
  const { reviewLabel } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const startedAt = new Date(now - 120_000).toISOString();
  assert.equal(reviewLabel({ status: 'running', startedAt }, now), '◐ Reviewer running · 2m');
  assert.equal(reviewLabel({ status: 'passed', startedAt }, now), '✓ Reviewer passed · 2m');
  assert.equal(reviewLabel({ status: 'changes', startedAt }, now), '◐ Reviewer changes asked · 2m');
});

test('steerView covers every state', async () => {
  const { steerView } = await load();
  assert.equal(steerView(null), null);
  assert.deepEqual(steerView({ state: 'pending' }), { word: 'Sending…', tone: 'plain' });
  const delivered = steerView({ state: 'delivered', at: Date.parse('2026-11-10T14:06:00') });
  assert.match(delivered.word, /^Delivered \d\d:\d\d$/);
  assert.equal(delivered.tone, 'plain');
  assert.deepEqual(steerView({ state: 'failed', reason: 'no such session' }), { word: 'Not delivered: no such session', tone: 'warn' });
  assert.deepEqual(steerView({ state: 'unclaimed' }), { word: 'Not picked up. Is the orchestrator session still open?', tone: 'warn' });
});

test('steerView tells an expired steer to be sent again', async () => {
  const { steerView } = await load();
  assert.deepEqual(steerView({ state: 'failed', reason: 'expired' }), { word: 'Not sent: it reached the orchestrator too late. Send it again.', tone: 'warn' });
});

test('boardError explains a missing board, a missing title and any other refusal', async () => {
  const { boardError } = await load();
  assert.match(boardError(409, { error: 'no board yet' }), /no board yet/);
  assert.equal(boardError(400, { error: 'x' }), 'Write a title first.');
  assert.equal(boardError(500, {}), 'Could not post. The server said 500.');
});

test('steerError words each refusal of a steer', async () => {
  const { steerError } = await load();
  assert.equal(steerError(409, { error: 'worker finished' }), 'This worker has finished, so it was not steered.');
  assert.equal(steerError(409, { error: 'orchestrator not live' }), 'The orchestrator session is not running, so nothing can deliver the message.');
  assert.equal(steerError(400, {}), 'Write a message first.');
  assert.equal(steerError(404, {}), 'Could not send. The server said 404.');
});

test('steerView says plain Not delivered when a failed steer has no reason', async () => {
  const { steerView } = await load();
  assert.deepEqual(steerView({ state: 'failed', reason: null }), { word: 'Not delivered', tone: 'warn' });
  assert.deepEqual(steerView({ state: 'failed' }), { word: 'Not delivered', tone: 'warn' });
});

test('steerError asks for a message only when the text is empty, else says it is too long or not valid', async () => {
  const { steerError } = await load();
  assert.equal(steerError(400, {}, '   '), 'Write a message first.');
  assert.equal(steerError(400, {}, ''), 'Write a message first.');
  assert.equal(steerError(400, {}, 'x'.repeat(2001)), 'The message is too long or not valid.');
});

test('a dead orchestration that never reached Finish reads Ended', async () => {
  const { switcherState } = await load();
  const now = Date.now();
  assert.equal(switcherState({ phase: 'waves', wave: 2, live: false, lastActiveAt: now - 2 * 3600_000 }, now), 'Ended 2h ago');
  assert.equal(switcherState({ phase: 'plan', live: false, lastActiveAt: now - 20_000 }, now), 'Ended just now');
});

test('stepAge reads now, then an age with ago, never a minus sign', async () => {
  const { stepAge } = await load();
  const now = Date.now();
  assert.equal(stepAge(0, new Date(now - 60_000).toISOString(), now), 'now');
  assert.equal(stepAge(1, new Date(now - 60_000).toISOString(), now), '1m ago');
});
