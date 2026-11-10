'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootServer } = require('./helpers');
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
