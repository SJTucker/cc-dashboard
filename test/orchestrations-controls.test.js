'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootServer, tmpDir, testConfig } = require('./helpers');
const { writeOrchestration } = require('./orchestration-fixture');
const { parseBoard } = require('../lib/orchestrations/board');
const { readSteers, writeSteerRequest } = require('../lib/orchestrations/controls');
const { createOrchestrations } = require('../lib/orchestrations/discover');
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

test('a worker whose meta flips to finished between polls is refused on the first look', async (t) => {
  const { url, config, o } = await setup(t);
  const route = `/api/orchestrations/${o.sessionId}/steer`;
  // One poll that sees finished: false.
  assert.equal(workerOf(await detailOf(url, o.sessionId), o.workerIds[0]).canSteer, true);
  const meta = path.join(path.dirname(o.transcript), o.sessionId, 'subagents', `agent-${o.workerIds[0]}.meta.json`);
  fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), finished: true }));
  const res = await send(url, route, { agentId: o.workerIds[0], text: 'too late' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'worker finished' });
  assert.equal(fs.existsSync(steerDir(config, o.sessionId)), false);
});

test('a refused steer does not advance the state the next poll builds on', async (t) => {
  const { url, o } = await setup(t);
  const meta = path.join(path.dirname(o.transcript), o.sessionId, 'subagents', `agent-${o.workerIds[0]}.meta.json`);
  await detailOf(url, o.sessionId);
  fs.writeFileSync(meta, JSON.stringify({ finished: true }));
  await send(url, `/api/orchestrations/${o.sessionId}/steer`, { agentId: o.workerIds[0], text: 'x' });
  // If the POST had recorded finished at this line count, this first detail poll would already hold the DONE event.
  const hasDone = (d) => workerOf(d, o.workerIds[0]).events.some((e) => e.type === 'DONE');
  assert.equal(hasDone(await detailOf(url, o.sessionId)), false);
  assert.equal(hasDone(await detailOf(url, o.sessionId)), true);
});

test('a Monitor --board path that does not end in .board.jsonl is ignored, so a post never writes it', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const o = writeOrchestration(config.configDir, { live: true, workers: [] });
  const victim = path.join(config.configDir, 'victim.txt');
  fs.writeFileSync(victim, 'keep\n');
  const lines = fs.readFileSync(o.transcript, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 0, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'mon', name: 'Monitor', input: { command: `x --watch --board ${victim}`, description: 'w' } }] } }));
  fs.writeFileSync(o.transcript, lines.join('\n') + '\n');
  const res = await send(url, `/api/orchestrations/${o.sessionId}/board`, { title: 'x' });
  assert.equal(res.status, 201);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(o.boardPath, 'utf8').trim().split('\n').length, 1, 'the post went to the image-derived board');
});

test('temp files a crashed write left are deleted after 24 h, fresh ones are kept', (t) => {
  const cfg = tmpDir(t, 'steer');
  const now = Date.now();
  const old = new Date(now - 25 * 3600 * 1000);
  const dir = steerDir({ configDir: cfg }, 's1');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'abc-123.json.4242');
  const fresh = path.join(dir, 'def-456.json.4243');
  fs.writeFileSync(stale, '{');
  fs.writeFileSync(fresh, '{');
  fs.utimesSync(stale, old, old);
  readSteers(cfg, 's1', now);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('a result that arrives after 30 s turns unclaimed into delivered', async (t) => {
  const { url, config, o } = await setup(t);
  const req = writeSteerRequest(config.configDir, o.sessionId, { agentId: o.workerIds[0], task: 1, text: 'late' }, Date.now() - 40000);
  assert.equal(workerOf(await detailOf(url, o.sessionId), o.workerIds[0]).lastSteer.state, 'unclaimed');
  fs.writeFileSync(path.join(steerDir(config, o.sessionId), `${req.id}.result.json`), JSON.stringify({ id: req.id, delivered: true, at: Date.now() }));
  assert.equal(workerOf(await detailOf(url, o.sessionId), o.workerIds[0]).lastSteer.state, 'delivered');
});

test('steer is cross-site refused', async (t) => {
  const { url, config, o } = await setup(t);
  const res = await fetch(`${url}/api/orchestrations/${o.sessionId}/steer`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ agentId: o.workerIds[0], text: 'x' }) });
  assert.equal(res.status, 403);
  assert.equal(fs.existsSync(steerDir(config, o.sessionId)), false);
});

test('board post is 409 when the board path in the transcript is relative', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const o = writeOrchestration(config.configDir, { live: true, workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }] });
  const rel = 'docs/relative.board.jsonl';
  fs.writeFileSync(o.transcript, fs.readFileSync(o.transcript, 'utf8').split(o.boardPath).join(rel));
  const res = await send(url, `/api/orchestrations/${o.sessionId}/board`, { title: 'x' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'no board yet' });
  assert.ok(!fs.existsSync(path.join(process.cwd(), rel)));
});

// A steer folder of a session that is not in any discovered group.
function steerFolder(config, name, files) {
  const dir = path.join(config.configDir, 'cc-dashboard', 'steer', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, ageH] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.writeFileSync(full, JSON.stringify({ id: 'x', agentId: 'a1', text: 't', at: Date.now() - ageH * 3600 * 1000 }));
    const when = new Date(Date.now() - ageH * 3600 * 1000);
    fs.utimesSync(full, when, when);
  }
  return dir;
}

test('list() cleans steer folders of sessions outside any group, and removes the emptied ones', (t) => {
  const config = testConfig(t);
  install(config);
  const stale = steerFolder(config, 'gone-1', { 'a-1.json': 30, 'a-1.result.json': 30, 'b-2.json.4242': 30 });
  const mixed = steerFolder(config, 'gone-2', { 'old-1.json': 30, 'new-1.json': 1 });
  const empty = steerFolder(config, 'gone-3', {});
  const foreign = steerFolder(config, 'gone-4', { 'notes.txt': 30, 'old-1.json': 30 });
  const badName = steerFolder(config, 'not a session.id', { 'old-1.json': 30 });
  const outside = tmpDir(t, 'outside');
  fs.writeFileSync(path.join(outside, 'old-1.json'), '{}');
  const when = new Date(Date.now() - 30 * 3600 * 1000);
  fs.utimesSync(path.join(outside, 'old-1.json'), when, when);
  fs.symlinkSync(outside, path.join(config.configDir, 'cc-dashboard', 'steer', 'linked-1'));
  fs.writeFileSync(path.join(config.configDir, 'cc-dashboard', 'steer', 'stray.json'), '{}');
  createOrchestrations(config.configDir).list();
  assert.equal(fs.existsSync(stale), false, 'an emptied folder is removed');
  assert.deepEqual(fs.readdirSync(mixed), ['new-1.json']);
  assert.equal(fs.existsSync(empty), false, 'an empty folder is removed');
  assert.deepEqual(fs.readdirSync(foreign).sort(), ['notes.txt'], 'a name outside the patterns is kept');
  assert.deepEqual(fs.readdirSync(badName), ['old-1.json'], 'a folder name outside SESSION_ID_PATTERN is skipped');
  assert.deepEqual(fs.readdirSync(outside), ['old-1.json'], 'a symlinked folder is not followed');
  assert.ok(fs.lstatSync(path.join(config.configDir, 'cc-dashboard', 'steer', 'linked-1')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(config.configDir, 'cc-dashboard', 'steer', 'stray.json')));
});

test('the steer folder cleanup runs at most once per 10 minutes', (t) => {
  const config = testConfig(t);
  install(config);
  let clock = Date.now();
  const orch = createOrchestrations(config.configDir, { now: () => clock });
  orch.list();
  const dir = steerFolder(config, 'gone-1', { 'old-1.json': 30 });
  clock += 9 * 60 * 1000;
  orch.list();
  assert.deepEqual(fs.readdirSync(dir), ['old-1.json']);
  clock += 61 * 1000;
  orch.list();
  assert.equal(fs.existsSync(dir), false);
});

test('a symlinked file in a steer folder is neither read nor deleted', (t) => {
  const config = testConfig(t);
  install(config);
  const dir = steerFolder(config, 'gone-1', {});
  const target = path.join(tmpDir(t, 'target'), 'keep.json');
  fs.writeFileSync(target, '{}');
  const when = new Date(Date.now() - 30 * 3600 * 1000);
  fs.utimesSync(target, when, when);
  fs.symlinkSync(target, path.join(dir, 'link-1.json'));
  createOrchestrations(config.configDir).list();
  assert.ok(fs.lstatSync(path.join(dir, 'link-1.json')).isSymbolicLink());
  assert.ok(fs.existsSync(target));
});

test('board text over the limit is refused with 400, as steer text is, and the limit itself is accepted', async (t) => {
  const { url, o } = await setup(t);
  const board = `/api/orchestrations/${o.sessionId}/board`;
  const steer = `/api/orchestrations/${o.sessionId}/steer`;
  const count = () => parseBoard(fs.readFileSync(o.boardPath, 'utf8').split('\n').filter(Boolean)).length;
  assert.equal((await send(url, board, { title: 'x'.repeat(121) })).status, 400);
  assert.equal((await send(url, board, { title: 'x', body: 'y'.repeat(2001) })).status, 400);
  assert.equal((await send(url, steer, { agentId: o.workerIds[0], text: 'z'.repeat(2001) })).status, 400);
  assert.equal(count(), 0);
  const ok = await send(url, board, { title: 'x'.repeat(120), body: 'y'.repeat(2000) });
  assert.equal(ok.status, 201);
  const post = await ok.json();
  assert.equal(post.title.length, 120);
  assert.equal(post.body.length, 2000);
  assert.equal(count(), 1);
});

test('appendPost still cuts long text for bin/board-post', (t) => {
  const file = path.join(tmpDir(t, 'board'), 'x.board.jsonl');
  const post = require('../lib/orchestrations/board').appendPost(file, { from: 'Task 1', title: 'x'.repeat(121), body: 'y'.repeat(2001) });
  assert.equal(post.title.length, 120);
  assert.equal(post.body.length, 2000);
});
