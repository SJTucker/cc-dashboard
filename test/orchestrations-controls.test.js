'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootServer, tmpDir } = require('./helpers');
const { writeOrchestration } = require('./orchestration-fixture');
const { parseBoard } = require('../lib/orchestrations/board');
const { readSteers, writeSteerRequest } = require('../lib/orchestrations/controls');
const { parseOrchestrator } = require('../lib/orchestrations/parse');
const { actionFeed } = require('../lib/orchestrations/feed');
const { stepsOf } = require('../lib/transcript-index');

function install(config) {
  const file = path.join(config.configDir, 'skills', 'orchestrate', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# orchestrate\n');
}

const working = (file) => [{ tool: 'Read', file_path: file }, { tool: 'Edit', file_path: file }];
const send = (url, route, body) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const steerDir = (config, sessionId) => path.join(config.configDir, 'cc-dashboard', 'steer', sessionId);
const detailOf = async (url, id) => (await fetch(`${url}/api/orchestrations/${id}`)).json();
const workerOf = (detail, agentId) => detail.waves.flatMap((w) => w.workers).find((w) => w.agentId === agentId);

async function setup(t, opts = {}) {
  const { url, config } = await bootServer(t);
  install(config);
  const o = writeOrchestration(config.configDir, {
    live: true,
    workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }, { task: 2, files: ['lib/b.js'], steps: working('lib/b.js'), finished: true }],
    ...opts,
  });
  return { url, config, o };
}

test('a dashboard post lands on the board from You', async (t) => {
  const { url, o } = await setup(t);
  const res = await send(url, `/api/orchestrations/${o.sessionId}/board`, { title: 'Use resolveRoot', body: 'see lib/paths.ts' });
  assert.equal(res.status, 201);
  const post = await res.json();
  assert.equal(post.from, 'You');
  const posts = parseBoard(fs.readFileSync(o.boardPath, 'utf8').split('\n').filter(Boolean));
  assert.equal(posts[0].from, 'You');
  assert.equal(posts[0].title, 'Use resolveRoot');
  assert.equal(posts[0].body, 'see lib/paths.ts');
});

test('board post without a title, or with a bad id, is refused', async (t) => {
  const { url, o } = await setup(t);
  assert.equal((await send(url, `/api/orchestrations/${o.sessionId}/board`, { title: '  ' })).status, 400);
  assert.equal((await send(url, `/api/orchestrations/${o.sessionId}/board`, { body: 'x' })).status, 400);
  assert.equal((await send(url, `/api/orchestrations/${o.sessionId}/board`, { title: 'x', body: 5 })).status, 400);
  assert.equal((await send(url, '/api/orchestrations/bad.id/board', { title: 'x' })).status, 400);
  assert.equal(parseBoard(fs.readFileSync(o.boardPath, 'utf8').split('\n').filter(Boolean)).length, 0);
});

test('board post to an unknown orchestration is 404', async (t) => {
  const { url } = await setup(t);
  assert.equal((await send(url, '/api/orchestrations/nope/board', { title: 'x' })).status, 404);
});

test('board post is cross-site refused', async (t) => {
  const { url, o } = await setup(t);
  const res = await fetch(`${url}/api/orchestrations/${o.sessionId}/board`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(res.status, 403);
});

test('board post is 409 when the orchestration has no board path', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const o = writeOrchestration(config.configDir, { live: true, workers: [] });
  // Drop the image Write and the board path with it: the session still shows the orchestrate skill call.
  const kept = fs.readFileSync(o.transcript, 'utf8').split('\n').filter(Boolean).filter((l) => !l.includes('toolu_image'));
  fs.writeFileSync(o.transcript, kept.join('\n') + '\n');
  const res = await send(url, `/api/orchestrations/${o.sessionId}/board`, { title: 'x' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'no board yet' });
});

test('steer writes a request in the live session folder', async (t) => {
  const { url, config, o } = await setup(t);
  const res = await send(url, `/api/orchestrations/${o.sessionId}/steer`, { agentId: o.workerIds[0], text: 'Stop after this file' });
  assert.equal(res.status, 202);
  const { id: reqId } = await res.json();
  const file = path.join(steerDir(config, o.sessionId), `${reqId}.json`);
  assert.ok(fs.existsSync(file));
  const req = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([req.id, req.agentId, req.task, req.text], [reqId, o.workerIds[0], 1, 'Stop after this file']);
  assert.equal(typeof req.at, 'number');
  const w = workerOf(await detailOf(url, o.sessionId), o.workerIds[0]);
  assert.equal(w.lastSteer.state, 'pending');
  assert.equal(w.canSteer, true);
});

test('steer with a bad body is refused and writes nothing', async (t) => {
  const { url, config, o } = await setup(t);
  const route = `/api/orchestrations/${o.sessionId}/steer`;
  assert.equal((await send(url, route, { agentId: o.workerIds[0], text: ' ' })).status, 400);
  assert.equal((await send(url, route, { agentId: o.workerIds[0], text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await send(url, route, { agentId: '../x', text: 'hi' })).status, 400);
  assert.equal((await send(url, route, { text: 'hi' })).status, 400);
  assert.equal(fs.existsSync(steerDir(config, o.sessionId)), false);
});

test('a result file makes lastSteer delivered, or failed with its reason', async (t) => {
  const { url, config, o } = await setup(t);
  const route = `/api/orchestrations/${o.sessionId}/steer`;
  const { id } = await (await send(url, route, { agentId: o.workerIds[0], text: 'Stop' })).json();
  fs.writeFileSync(path.join(steerDir(config, o.sessionId), `${id}.result.json`), JSON.stringify({ id, delivered: true, at: Date.now() }));
  const w = workerOf(await detailOf(url, o.sessionId), o.workerIds[0]);
  assert.equal(w.lastSteer.state, 'delivered');
  assert.equal(w.lastSteer.text, 'Stop');
  fs.writeFileSync(path.join(steerDir(config, o.sessionId), `${id}.result.json`), JSON.stringify({ id, delivered: false, reason: 'send failed', at: Date.now() }));
  const failed = workerOf(await detailOf(url, o.sessionId), o.workerIds[0]);
  assert.deepEqual([failed.lastSteer.state, failed.lastSteer.reason], ['failed', 'send failed']);
});

test('no result after 30 s is unclaimed, not pending forever', async (t) => {
  const { url, config, o } = await setup(t);
  const now = Date.now();
  writeSteerRequest(config.configDir, o.sessionId, { agentId: o.workerIds[0], task: 1, text: 'old' }, now - 31000);
  assert.equal(workerOf(await detailOf(url, o.sessionId), o.workerIds[0]).lastSteer.state, 'unclaimed');
  writeSteerRequest(config.configDir, o.sessionId, { agentId: o.workerIds[0], task: 1, text: 'new' }, now - 5000);
  const w = workerOf(await detailOf(url, o.sessionId), o.workerIds[0]);
  assert.deepEqual([w.lastSteer.state, w.lastSteer.text], ['pending', 'new']);
});

test('steering a finished worker is refused and writes no file', async (t) => {
  const { url, config, o } = await setup(t);
  // The finished flag in the worker's meta file counts only once it has held for two polls.
  await detailOf(url, o.sessionId);
  const detail = await detailOf(url, o.sessionId);
  assert.equal(workerOf(detail, o.workerIds[1]).canSteer, false);
  const res = await send(url, `/api/orchestrations/${o.sessionId}/steer`, { agentId: o.workerIds[1], text: 'one more thing' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'worker finished' });
  assert.equal(fs.existsSync(steerDir(config, o.sessionId)), false);
});

test('steering an agent of another orchestration is refused', async (t) => {
  const { url, config, o } = await setup(t);
  const other = writeOrchestration(config.configDir, { live: true, topic: 'other', workers: [{ steps: working('lib/z.js') }] });
  const res = await send(url, `/api/orchestrations/${o.sessionId}/steer`, { agentId: other.workerIds[0], text: 'hi' });
  assert.equal(res.status, 404);
  assert.equal((await send(url, '/api/orchestrations/nope/steer', { agentId: o.workerIds[0], text: 'hi' })).status, 404);
  assert.equal(fs.existsSync(steerDir(config, o.sessionId)), false);
});

test('steering when the orchestrator is not live is refused', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const o = writeOrchestration(config.configDir, { live: false, workers: [{ steps: working('lib/a.js') }] });
  const res = await send(url, `/api/orchestrations/${o.sessionId}/steer`, { agentId: o.workerIds[0], text: 'hi' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'orchestrator not live' });
  assert.equal(fs.existsSync(steerDir(config, o.sessionId)), false);
});

test('steer files older than 24 h are deleted, only in that session folder', (t) => {
  const cfg = tmpDir(t, 'steer');
  const now = Date.now();
  const old = now - 25 * 3600 * 1000;
  writeSteerRequest(cfg, 's1', { agentId: 'a1', task: 1, text: 'old' }, old);
  const stale = writeSteerRequest(cfg, 's1', { agentId: 'a2', task: 2, text: 'old too' }, old);
  fs.writeFileSync(path.join(steerDir({ configDir: cfg }, 's1'), `${stale.id}.result.json`), JSON.stringify({ id: stale.id, delivered: true, at: old }));
  const fresh = writeSteerRequest(cfg, 's1', { agentId: 'a3', task: 3, text: 'new' }, now - 1000);
  const elsewhere = writeSteerRequest(cfg, 's2', { agentId: 'a1', task: 1, text: 'other session' }, old);
  const dir = steerDir({ configDir: cfg }, 's1');
  for (const name of fs.readdirSync(dir)) {
    if (!name.includes(fresh.id)) fs.utimesSync(path.join(dir, name), new Date(old), new Date(old));
  }
  const steers = readSteers(cfg, 's1', now);
  assert.deepEqual([...steers.keys()], ['a3']);
  assert.deepEqual(fs.readdirSync(dir), [`${fresh.id}.json`]);
  assert.ok(fs.existsSync(path.join(steerDir({ configDir: cfg }, 's2'), `${elsewhere.id}.json`)));
});

// The row the mod's $.session.append wrote on 2.1.322.
const noteRow = (task, text, timestamp) => JSON.stringify({
  type: 'user', isMeta: true, timestamp, sessionId: 's1',
  message: { role: 'user', content: [{ type: 'text', text: `You steered Task ${task} from the dashboard: ${text}` }] },
});

function noteLines() {
  const o = writeOrchestration(tmpDir(null, 'note'), { live: true, workers: [{ task: 1, steps: working('lib/a.js') }, { task: 2, steps: working('lib/b.js') }] });
  const lines = fs.readFileSync(o.transcript, 'utf8').split('\n').filter(Boolean);
  lines.push(noteRow(2, 'Stop after this file', '2026-11-10T09:30:00.000Z'));
  return { lines, workerIds: o.workerIds };
}

test('stepsOf drops the isMeta steer note, so the feed reads it from parsed.steers', () => {
  const { lines } = noteLines();
  assert.equal(stepsOf(lines, 1, lines.length).some((s) => /You steered/.test(s.text)), false);
});

test('the steer note shows in the feed as You steered', () => {
  const { lines } = noteLines();
  const entry = actionFeed(lines, parseOrchestrator(lines)).find((e) => e.text === 'You steered Task 2');
  assert.ok(entry);
  assert.equal(entry.glyph, '↗');
  assert.equal(entry.detail, 'Stop after this file');
  assert.equal(entry.at, '2026-11-10T09:30:00.000Z');
});

test('the steer note counts as a steer of that task\'s worker, in Steered N', async (t) => {
  const { url, config, o } = await setup(t);
  fs.appendFileSync(o.transcript, noteRow(1, 'Stop', new Date().toISOString()) + '\n');
  const w = workerOf(await detailOf(url, o.sessionId), o.workerIds[0]);
  assert.equal(w.steerCount, 1);
});
