'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootServer, testConfig } = require('./helpers');
const { createOrchestrations } = require('../lib/orchestrations/discover');
const { writeOrchestration } = require('./orchestration-fixture');

function install(config) {
  const file = path.join(config.configDir, 'skills', 'orchestrate', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# orchestrate\n');
}

function queueReset(config, sessionId, text = 'Read x. You are the orchestrator for y.') {
  const file = path.join(config.configDir, 'cc-dashboard', 'reset-prompt', `${sessionId}.txt`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const get = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
};

const working = (file) => [{ tool: 'Read', file_path: file }, { tool: 'Edit', file_path: file }];

test('not installed: one cheap answer', async (t) => {
  const { url, config } = await bootServer(t);
  writeOrchestration(config.configDir, { live: true, workers: [{ steps: working('lib/x.js') }] });
  assert.deepEqual((await get(url + '/api/orchestrations')).body, { installed: false, orchestrations: [] });
});

test('not installed: list() reads no session and finds no transcript', (t) => {
  const { config } = { config: testConfig(t) };
  writeOrchestration(config.configDir, { live: true, workers: [{ steps: working('lib/x.js') }] });
  const o = createOrchestrations(config.configDir);
  assert.deepEqual(o.list(), []);
  assert.deepEqual(o.sizes(), { transcripts: 0, scans: 0, parsed: 0, seen: 0, misses: 0, lines: 0 });
  const readdir = t.mock.method(fs, 'readdirSync');
  o.list();
  assert.equal(readdir.mock.callCount(), 0);
});

test('lists an orchestration with its counts', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const o = writeOrchestration(config.configDir, {
    live: true,
    board: [{ t: '2026-11-10T09:00:00.000Z', from: 'Task 1', title: 'Hello', body: '' }],
    workers: [1, 2, 3].map((n) => ({ task: n, files: [`lib/f${n}.js`], steps: working(`lib/f${n}.js`) })),
  });
  const { body } = await get(url + '/api/orchestrations');
  assert.equal(body.installed, true);
  assert.equal(body.orchestrations.length, 1);
  const s = body.orchestrations[0];
  assert.equal(s.id, o.sessionId);
  assert.equal(s.topic, 'demo');
  assert.equal(s.project, 'demo');
  assert.equal(s.branch, 'demo');
  assert.equal(s.live, true);
  assert.equal(s.phase, 'waves');
  assert.equal(s.wave, 1);
  assert.deepEqual(s.counts, { working: 3, review: 0, merged: 0, attention: 0 });
  assert.equal(s.boardCount, 1);
  const d = await get(`${url}/api/orchestrations/${o.sessionId}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.imagePath, o.imagePath);
  assert.equal(d.body.waves[0].workers.length, 3);
  assert.equal(d.body.board[0].title, 'Hello');
  assert.ok(d.body.feed.length > 0);
  assert.ok(d.body.now.text);
});

test('merged and finished workers count under merged and review', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  writeOrchestration(config.configDir, {
    live: true,
    workers: [
      { task: 1, files: ['lib/a.js'], steps: working('lib/a.js'), merged: true },
      { task: 2, files: ['lib/b.js'], steps: working('lib/b.js') },
    ],
  });
  const { body } = await get(url + '/api/orchestrations');
  assert.equal(body.orchestrations[0].counts.merged, 1);
  assert.equal(body.orchestrations[0].counts.working, 1);
});

test('two orchestrations in one project stay separate', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const project = path.join(config.configDir, 'work', 'shared');
  const a = writeOrchestration(config.configDir, {
    project, topic: 'alpha', live: true,
    board: [{ t: '2026-11-10T09:00:00.000Z', from: 'Task 1', title: 'alpha post', body: '' }],
    workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }],
  });
  const b = writeOrchestration(config.configDir, {
    project, topic: 'beta', live: true,
    board: [{ t: '2026-11-10T09:01:00.000Z', from: 'Task 1', title: 'beta post', body: '' }],
    workers: [{ task: 1, files: ['lib/b.js'], steps: working('lib/b.js') }, { task: 2, files: ['lib/c.js'], steps: working('lib/c.js') }],
  });
  const { body } = await get(url + '/api/orchestrations');
  assert.equal(body.orchestrations.length, 2);
  assert.deepEqual(body.orchestrations.map((s) => s.topic).sort(), ['alpha', 'beta']);
  const da = (await get(`${url}/api/orchestrations/${a.sessionId}`)).body;
  const db = (await get(`${url}/api/orchestrations/${b.sessionId}`)).body;
  assert.deepEqual(da.waves.flatMap((w) => w.workers).map((w) => w.agentId), a.workerIds);
  assert.deepEqual(db.waves.flatMap((w) => w.workers).map((w) => w.agentId).sort(), [...b.workerIds].sort());
  assert.deepEqual(da.board.map((p) => p.title), ['alpha post']);
  assert.deepEqual(db.board.map((p) => p.title), ['beta post']);
});

test('reset keeps one card and one id', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const a = writeOrchestration(config.configDir, { sessionId: 'sess-a', live: false });
  queueReset(config, a.sessionId);
  let { body } = await get(url + '/api/orchestrations');
  assert.equal(body.orchestrations.length, 1);
  assert.equal(body.orchestrations[0].id, 'sess-a');
  assert.equal(body.orchestrations[0].phase, 'reset');

  writeOrchestration(config.configDir, {
    sessionId: 'sess-b', clearedFrom: 'sess-a', resetLine: true, live: true,
    workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }],
  });
  ({ body } = await get(url + '/api/orchestrations'));
  assert.equal(body.orchestrations.length, 1);
  assert.equal(body.orchestrations[0].id, 'sess-a');
  assert.equal(body.orchestrations[0].phase, 'waves');
  assert.equal(body.orchestrations[0].live, true);
  const d = (await get(`${url}/api/orchestrations/sess-a`)).body;
  assert.equal(d.waves[0].workers.length, 1);
  assert.equal((await get(`${url}/api/orchestrations/sess-b`)).status, 404);
});

test('a plan with no image written and no reset queued is in the plan phase', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const dir = path.join(config.configDir, 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', message: { role: 'user', content: 'go' }, timestamp: new Date().toISOString() },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'orchestrate' } }] }, timestamp: new Date().toISOString() },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'plan-1.jsonl'), lines);
  fs.mkdirSync(path.join(config.configDir, 'cc-dashboard', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config.configDir, 'cc-dashboard', 'sessions', 'plan-1.json'), JSON.stringify({ sessionId: 'plan-1', lastActiveAt: Date.now(), project: 'p', costUsd: 0, durationMs: 0, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0 }));
  const { body } = await get(url + '/api/orchestrations');
  assert.equal(body.orchestrations.length, 1);
  assert.equal(body.orchestrations[0].phase, 'plan');
  assert.equal(body.orchestrations[0].wave, null);
  assert.equal(body.orchestrations[0].topic, 'p');
});

test('detail rejects a bad id and 404s an unknown one', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  assert.equal((await get(url + '/api/orchestrations/bad.id')).status, 400);
  assert.equal((await get(url + '/api/orchestrations/nope')).status, 404);
});

test('a non-orchestrator session is not listed', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const dir = path.join(config.configDir, 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plain-1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: new Date().toISOString() }) + '\n');
  fs.mkdirSync(path.join(config.configDir, 'cc-dashboard', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config.configDir, 'cc-dashboard', 'sessions', 'plain-1.json'), JSON.stringify({ sessionId: 'plain-1', lastActiveAt: Date.now(), project: 'p', costUsd: 0, durationMs: 0, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0 }));
  const { body } = await get(url + '/api/orchestrations');
  assert.deepEqual(body, { installed: true, orchestrations: [] });
  assert.equal((await get(url + '/api/orchestrations/plain-1')).status, 404);
});

test('a waiting orchestration sorts first and is marked waiting', async (t) => {
  const { url, config } = await bootServer(t);
  install(config);
  const a = writeOrchestration(config.configDir, { topic: 'busy', live: true, workers: [{ steps: working('lib/a.js') }] });
  const b = writeOrchestration(config.configDir, { topic: 'idle', live: true });
  const dir = path.join(config.configDir, 'cc-dashboard', 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const at = Date.now();
  fs.writeFileSync(path.join(dir, `${b.sessionId}.json`), JSON.stringify({ sessionId: b.sessionId, state: 'waiting', since: at, tool: null, subagents: 0, updatedAt: at }));
  const { body } = await get(url + '/api/orchestrations');
  assert.deepEqual(body.orchestrations.map((s) => [s.id, s.waiting]), [[b.sessionId, true], [a.sessionId, false]]);
  assert.equal((await get(`${url}/api/orchestrations/${b.sessionId}`)).body.now.text, 'Waiting for you');
});

function plainSession(config, id, content = 'hello') {
  const dir = path.join(config.configDir, 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: new Date().toISOString() }) + '\n');
  fs.mkdirSync(path.join(config.configDir, 'cc-dashboard', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config.configDir, 'cc-dashboard', 'sessions', `${id}.json`), JSON.stringify({ sessionId: id, lastActiveAt: Date.now(), project: 'p', costUsd: 0, durationMs: 0, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0 }));
  return file;
}

test('a non-orchestrator session keeps no lines after list()', (t) => {
  const config = testConfig(t);
  install(config);
  plainSession(config, 'plain-1');
  const o = createOrchestrations(config.configDir);
  assert.deepEqual(o.list(), []);
  const sizes = o.sizes();
  assert.equal(sizes.lines, 0);
  assert.equal(sizes.parsed, 0);
});

test('a session that calls the orchestrate Skill later is listed on the next list()', (t) => {
  const config = testConfig(t);
  install(config);
  const file = plainSession(config, 'late-1');
  const o = createOrchestrations(config.configDir);
  assert.deepEqual(o.list(), []);
  const call = { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'orchestrate' } }] } };
  fs.appendFileSync(file, JSON.stringify(call) + '\n');
  assert.deepEqual(o.list().map((s) => s.id), ['late-1']);
});

test('an id with no transcript is looked up at most once per 60 s', (t) => {
  const config = testConfig(t);
  install(config);
  fs.mkdirSync(path.join(config.configDir, 'cc-dashboard', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config.configDir, 'cc-dashboard', 'sessions', 'headless-1.json'), JSON.stringify({ sessionId: 'headless-1', lastActiveAt: Date.now(), project: 'p', costUsd: 0, durationMs: 0, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0 }));
  let clock = Date.now();
  const o = createOrchestrations(config.configDir, { now: () => clock });
  const projects = path.join(config.configDir, 'projects');
  const readdir = t.mock.method(fs, 'readdirSync');
  const scans = () => readdir.mock.calls.filter((c) => c.arguments[0] === projects).length;
  o.list();
  o.list();
  assert.equal(scans(), 1);
  clock += 61000;
  o.list();
  assert.equal(scans(), 2);
});

test('state for a session that left the snapshot window is dropped', (t) => {
  const config = testConfig(t);
  install(config);
  const o1 = writeOrchestration(config.configDir, { live: true, workers: [{ steps: working('lib/a.js') }] });
  plainSession(config, 'plain-2');
  const o = createOrchestrations(config.configDir);
  assert.equal(o.list().length, 1);
  o.detail(o1.sessionId); // only detail() keeps seen state
  const before = o.sizes();
  assert.ok(before.transcripts > 0 && before.parsed > 0 && before.seen > 0 && before.scans > 0);
  fs.rmSync(path.join(config.configDir, 'cc-dashboard', 'sessions', `${o1.sessionId}.json`));
  fs.rmSync(path.join(config.configDir, 'cc-dashboard', 'sessions', 'plain-2.json'));
  assert.deepEqual(o.list(), []);
  assert.deepEqual(o.sizes(), { transcripts: 0, scans: 0, parsed: 0, seen: 0, misses: 0, lines: o.sizes().lines });
});

test('list() does not advance the finished-flag state that detail() holds for a poll', (t) => {
  const { config } = { config: testConfig(t) };
  install(config);
  const o = writeOrchestration(config.configDir, { live: true, workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js'), finished: true }] });
  const orch = createOrchestrations(config.configDir);
  const worker = (d) => d.waves.flatMap((w) => w.workers)[0];
  const summary = orch.list()[0];
  assert.equal(summary.counts.review, 1);
  // watchEvents adds the DONE event once the flag has held for a poll with no new lines.
  assert.equal(worker(orch.detail(o.sessionId)).events.some((e) => e.type === 'DONE'), false);
  assert.equal(worker(orch.detail(o.sessionId)).events.some((e) => e.type === 'DONE'), true);
});

test('one detail poll after the meta flag flips shows done and canSteer false', (t) => {
  const config = testConfig(t);
  install(config);
  const o = writeOrchestration(config.configDir, { live: true, workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }] });
  const orch = createOrchestrations(config.configDir);
  const worker = (d) => d.waves.flatMap((w) => w.workers)[0];
  assert.equal(worker(orch.detail(o.sessionId)).status, 'working');
  const meta = path.join(path.dirname(o.transcript), o.sessionId, 'subagents', `agent-${o.workerIds[0]}.meta.json`);
  fs.writeFileSync(meta, JSON.stringify({ finished: true }));
  const w = worker(orch.detail(o.sessionId));
  assert.equal(w.status, 'done');
  assert.equal(w.canSteer, false);
});

const skillCall = () => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'orchestrate' } }] } });

test('a transcript line that is the JSON literal null does not break detection', (t) => {
  const config = testConfig(t);
  install(config);
  const file = plainSession(config, 'null-1');
  fs.writeFileSync(file, 'null\n');
  const o = createOrchestrations(config.configDir);
  assert.deepEqual(o.list(), []);
  fs.appendFileSync(file, skillCall() + '\n');
  assert.deepEqual(o.list().map((s) => s.id), ['null-1']);
});

test('an orchestrate marker split across two offset reads is found once the line completes', (t) => {
  const config = testConfig(t);
  install(config);
  const file = plainSession(config, 'split-1');
  const o = createOrchestrations(config.configDir);
  assert.deepEqual(o.list(), []);
  const call = skillCall();
  const half = Math.floor(call.length / 2);
  fs.appendFileSync(file, call.slice(0, half));
  assert.deepEqual(o.list(), []);
  fs.appendFileSync(file, call.slice(half) + '\n');
  assert.deepEqual(o.list().map((s) => s.id), ['split-1']);
});

test('detail re-parses a transcript that grew, though the lines array keeps its identity', (t) => {
  const config = testConfig(t);
  install(config);
  const a = writeOrchestration(config.configDir, { sessionId: 'grow-1', live: true, workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }] });
  const o = createOrchestrations(config.configDir);
  assert.equal(o.detail('grow-1').waves[0].workers.length, 1);
  const prompt = 'Your worktree is /p/.worktrees/demo-t2; work only there.\nRead x.md in full, then do Task 2 of y.md, "Two".\nFiles this task touches: lib/b.js.\nDone when: ok\n';
  const t0 = new Date().toISOString();
  const launch = { type: 'assistant', timestamp: t0, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ag2', name: 'Agent', input: { description: 'Task 2 worker', prompt } }] } };
  const result = { type: 'user', timestamp: t0, toolUseResult: { agentId: 'agent2', prompt }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag2', content: 'ok' }] } };
  fs.appendFileSync(a.transcript, JSON.stringify(launch) + '\n' + JSON.stringify(result) + '\n');
  assert.equal(o.detail('grow-1').waves.flatMap((w) => w.workers).length, 2);
});

test('a dashboard note after a reset counts as a steer of a worker launched before it', (t) => {
  const config = testConfig(t);
  install(config);
  writeOrchestration(config.configDir, { sessionId: 'sess-a', live: false, workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }] });
  const b = writeOrchestration(config.configDir, { sessionId: 'sess-b', clearedFrom: 'sess-a', resetLine: true, live: true, workers: [] });
  const note = { type: 'user', isMeta: true, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'You steered Task 1 from the dashboard: use the helper' }] } };
  fs.appendFileSync(b.transcript, JSON.stringify(note) + '\n');
  const d = createOrchestrations(config.configDir).detail('sess-a');
  const workers = d.waves.flatMap((w) => w.workers);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].steerCount, 1);
  assert.ok(d.feed.some((f) => f.text === 'You steered Task 1'));
});

test('a dashboard note is not mapped to a worker a later session launched', (t) => {
  const config = testConfig(t);
  install(config);
  writeOrchestration(config.configDir, { sessionId: 'sess-a', live: false, workers: [] });
  const b = writeOrchestration(config.configDir, { sessionId: 'sess-b', clearedFrom: 'sess-a', resetLine: true, live: false, workers: [] });
  writeOrchestration(config.configDir, { sessionId: 'sess-c', clearedFrom: 'sess-b', resetLine: true, live: true, workers: [{ task: 1, files: ['lib/a.js'], steps: working('lib/a.js') }] });
  const note = { type: 'user', isMeta: true, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'You steered Task 1 from the dashboard: early' }] } };
  fs.appendFileSync(b.transcript, JSON.stringify(note) + '\n');
  const workers = createOrchestrations(config.configDir).detail('sess-a').waves.flatMap((w) => w.workers);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].steerCount, 0);
});
