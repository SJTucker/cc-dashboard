'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { workerState, resolveStatuses, groupWaves } = require('../lib/orchestrations/workers.js');

const T0 = Date.parse('2026-11-10T10:00:00Z');
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();

function tool(name, input, sec, usage) {
  const message = { role: 'assistant', content: [{ type: 'tool_use', id: `id${sec}`, name, input }] };
  if (usage) message.usage = usage;
  return JSON.stringify({ type: 'assistant', timestamp: iso(sec), message });
}
function text(t, sec) {
  return JSON.stringify({ type: 'assistant', timestamp: iso(sec), message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
}
function failure(sec) {
  return [
    tool('Bash', { command: 'npm test' }, sec),
    JSON.stringify({ type: 'user', timestamp: iso(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `id${sec}`, is_error: true, content: 'boom' }] } }),
  ];
}

const agent = { agentId: 'a1', task: '3', title: 'Workers', files: ['lib/orchestrations/workers.js'], doneWhen: 'tests pass', startedAt: iso(0) };
const opts = (secAfter) => ({ now: T0 + secAfter * 1000 });
const read = (lines, mtimeSec) => ({ lines, mtimeMs: T0 + mtimeSec * 1000 });

test('a worker with no transcript yet is starting', () => {
  const { state } = workerState(agent, null, null, undefined, opts(1));
  assert.equal(state.raw, 'starting');
  assert.deepEqual(state.steps, []);
  assert.equal(state.contextTokens, null);
});

test('current is the latest tool step and steps keeps 8', () => {
  const lines = [];
  for (let i = 0; i < 11; i++) lines.push(tool('Read', { file_path: `f${i}.js` }, i));
  lines.push(tool('Edit', { file_path: 'lib/orchestrations/workers.js' }, 11));
  const { state } = workerState(agent, read(lines, 11), null, undefined, opts(12));
  assert.equal(state.steps.length, 8);
  assert.equal(state.current.tool, 'Edit');
  assert.deepEqual(state.edited, ['lib/orchestrations/workers.js']);
  assert.equal(state.raw, 'working');
});

test('DRIFT from an edit outside the task files', () => {
  const lines = [tool('Edit', { file_path: 'server.js' }, 1)];
  const { state } = workerState(agent, read(lines, 1), null, undefined, opts(2));
  assert.equal(state.events.at(-1).type, 'DRIFT');
  assert.equal(state.raw, 'stuck');
});

test('STUCK after three identical failures', () => {
  const lines = [...failure(1), ...failure(2), ...failure(3)];
  const { state } = workerState(agent, read(lines, 3), null, undefined, opts(4));
  assert.equal(state.events.at(-1).type, 'STUCK');
});

test('BUDGET once context passes 120000', () => {
  const lines = [tool('Read', { file_path: 'a.js' }, 1, { input_tokens: 1, cache_read_input_tokens: 100000, cache_creation_input_tokens: 20000 })];
  const { state } = workerState(agent, read(lines, 1), null, undefined, opts(2));
  assert.equal(state.contextTokens, 120001);
  assert.equal(state.events.at(-1).type, 'BUDGET');
});

test('quiet after 5 minutes without growth', () => {
  const lines = [tool('Read', { file_path: 'a.js' }, 1)];
  assert.equal(workerState(agent, read(lines, 1), null, undefined, opts(1 + 300)).state.raw, 'working');
  const quiet = workerState(agent, read(lines, 1), null, undefined, { now: T0 + 1000 + 300001 });
  assert.equal(quiet.state.raw, 'quiet');
});

test('a finished transcript is done and carries its report', () => {
  const lines = [tool('Read', { file_path: 'a.js' }, 1), text('All green.', 2)];
  // The finished flag ends the watch only once it has held for a poll with no new lines.
  const first = workerState(agent, read(lines, 2), { finished: true }, undefined, opts(3));
  assert.equal(first.state.raw, 'working');
  const { state } = workerState(agent, read(lines, 2), { finished: true }, first.seen, opts(6));
  assert.equal(state.raw, 'done');
  assert.equal(state.report, 'All green.');
  assert.equal(state.events.at(-1).type, 'DONE');
});

test('seen carries over so events are not repeated', () => {
  const lines = [tool('Edit', { file_path: 'server.js' }, 1)];
  const first = workerState(agent, read(lines, 1), null, undefined, opts(2));
  const second = workerState(agent, read(lines, 1), null, first.seen, opts(3));
  assert.equal(first.state.events.length, 1);
  assert.equal(second.state.events.length, 1);
  const more = [...lines, tool('Edit', { file_path: 'other.js' }, 4)];
  const third = workerState(agent, read(more, 4), null, second.seen, opts(5));
  assert.equal(third.state.events.length, 2);
});

const st = (over) => ({ agentId: 'w', task: '1', raw: 'working', report: null, steps: [], events: [], quiet: false, startedAt: iso(0), lastActiveAt: iso(1), ...over });

test('a running reviewer puts its task in review', () => {
  const resolved = resolveStatuses([st({ raw: 'done' })], [st({ agentId: 'r', raw: 'working', startedAt: iso(50) })], [], []);
  assert.equal(resolved[0].status, 'review');
  assert.deepEqual(resolved[0].review, { status: 'running', startedAt: iso(50) });
});

test('a reviewer report starting with pass marks passed, any other changes', () => {
  const w = [st({ raw: 'done' })];
  assert.equal(resolveStatuses(w, [st({ raw: 'done', report: ' Pass - looks good' })], [], [])[0].status, 'passed');
  const changes = resolveStatuses(w, [st({ raw: 'done', report: 'Fix the tests' })], [], []);
  assert.equal(changes[0].status, 'changes');
  assert.equal(changes[0].review.status, 'changes');
});

test('the latest reviewer for a task decides', () => {
  const rs = [st({ raw: 'done', report: 'changes needed', startedAt: iso(10) }), st({ raw: 'done', report: 'pass', startedAt: iso(20) })];
  assert.equal(resolveStatuses([st({ raw: 'done' })], rs, [], [])[0].status, 'passed');
});

test('a merge wins over every other status', () => {
  const resolved = resolveStatuses([st({ raw: 'stuck' })], [st({ raw: 'working' })], [{ task: '1' }], []);
  assert.equal(resolved[0].status, 'merged');
});

const ev = (at) => [{ type: 'STUCK', text: 'x', line: 3, at: iso(at) }];

test('a steer before the attention event leaves the worker stuck', () => {
  const w = st({ raw: 'stuck', events: ev(10), lastActiveAt: iso(10) });
  assert.equal(resolveStatuses([w], [], [], [{ to: 'w', at: iso(5) }])[0].status, 'stuck');
});

test('an attention event then a steer with no step after stays stuck', () => {
  const w = st({ raw: 'stuck', events: ev(10), lastActiveAt: iso(10) });
  assert.equal(resolveStatuses([w], [], [], [{ to: 'w', at: iso(20) }])[0].status, 'stuck');
  assert.equal(resolveStatuses([w], [], [], [])[0].status, 'stuck');
  assert.equal(resolveStatuses([w], [], [], [{ to: 'other', at: iso(20) }])[0].status, 'stuck');
});

test('an attention event, a steer, then a step clears stuck', () => {
  const w = st({ raw: 'stuck', events: ev(10), lastActiveAt: iso(30) });
  assert.equal(resolveStatuses([w], [], [], [{ to: 'w', at: iso(20) }])[0].status, 'working');
  const q = st({ raw: 'stuck', quiet: true, events: ev(10), lastActiveAt: iso(30) });
  assert.equal(resolveStatuses([q], [], [], [{ to: 'w', at: iso(20) }])[0].status, 'quiet');
});

test('events carry the time of the step that raised them', () => {
  const lines = [tool('Read', { file_path: 'a.js' }, 1), tool('Edit', { file_path: 'server.js' }, 7), tool('Read', { file_path: 'b.js' }, 9)];
  const { state } = workerState(agent, read(lines, 9), null, undefined, opts(10));
  assert.equal(state.events[0].at, iso(7));
});

test('a task of null never matches a reviewer or merge without a task', () => {
  const w = st({ raw: 'done', task: null });
  const resolved = resolveStatuses([w], [st({ raw: 'working', task: null })], [{ task: null }], []);
  assert.equal(resolved[0].status, 'done');
  assert.equal(resolved[0].review, null);
});

test('a transcript with no complete lines is starting', () => {
  assert.equal(workerState(agent, read([], 0), null, undefined, opts(1)).state.raw, 'starting');
});

test('quiet and starting pass through', () => {
  assert.equal(resolveStatuses([st({ raw: 'quiet' })], [], [], [])[0].status, 'quiet');
  assert.equal(resolveStatuses([st({ raw: 'starting' })], [], [], [])[0].status, 'starting');
  assert.equal(resolveStatuses([st({ raw: 'done' })], [], [], [])[0].status, 'done');
});

test('a worker started after all earlier ones finished opens wave 2', () => {
  const w = (id, sec, status, lastSec = sec + 10) => ({ agentId: id, startedAt: iso(sec), lastActiveAt: iso(lastSec), status });
  const ws = [w('e', 101, 'working'), w('a', 0, 'merged', 10), w('b', 1, 'done', 20), w('c', 2, 'passed', 30), w('d', 100, 'working')];
  const waves = groupWaves(ws);
  assert.deepEqual(waves.map((x) => x.workers.length), [3, 2]);
  assert.deepEqual(waves.map((x) => x.n), [1, 2]);
  assert.equal(waves[1].startedAt, iso(100));
  // A worker that finished after the next one started does not split the wave.
  assert.equal(groupWaves([w('a', 0, 'done', 50), w('b', 5, 'working')]).length, 1);
  assert.equal(groupWaves([w('a', 0, 'working'), w('b', 5, 'working')]).length, 1);
});

test('touched lists edited files that match the task files, absolute or relative', () => {
  const task = { ...agent, files: ['lib/a.js', 'docs/'] };
  const lines = [
    tool('Edit', { file_path: '/work/.worktrees/x-t3/lib/a.js' }, 1),
    tool('Edit', { file_path: '/work/.worktrees/x-t3/docs/guide.md' }, 2),
    tool('Edit', { file_path: '/work/.worktrees/x-t3/lib/other.js' }, 3),
  ];
  const { state } = workerState(task, read(lines, 3), null, undefined, opts(4));
  assert.deepEqual(state.touched, ['/work/.worktrees/x-t3/lib/a.js', '/work/.worktrees/x-t3/docs/guide.md']);
  assert.deepEqual(workerState(task, null, null, undefined, opts(1)).state.touched, []);
});

test('steerCount counts the steers sent to the worker', () => {
  const steers = [{ to: 'w', at: iso(5) }, { to: 'other', at: iso(6) }, { to: 'w', at: iso(7) }];
  const resolved = resolveStatuses([st({}), st({ agentId: 'z', task: '2' })], [], [], steers);
  assert.equal(resolved[0].steerCount, 2);
  assert.equal(resolved[1].steerCount, 0);
});

test('a relaunched worker does not take the verdict of the reviewer of its earlier run', () => {
  const oldWorker = st({ agentId: 'old', raw: 'done', startedAt: iso(0) });
  const newWorker = st({ agentId: 'new', raw: 'working', startedAt: iso(200) });
  const reviewer = st({ agentId: 'r', raw: 'done', report: 'Changes: fix x', startedAt: iso(100) });
  const [a, b] = resolveStatuses([oldWorker, newWorker], [reviewer], [], []);
  assert.equal(a.status, 'changes');
  assert.equal(b.status, 'working');
  assert.equal(b.review, null);
});

test('a rerun worker does not take the merge of its earlier run', () => {
  const oldWorker = st({ agentId: 'old', raw: 'done', startedAt: iso(0) });
  const newWorker = st({ agentId: 'new', raw: 'working', startedAt: iso(200) });
  const [a, b] = resolveStatuses([oldWorker, newWorker], [], [{ task: '1', at: iso(100) }], []);
  assert.equal(a.status, 'merged');
  assert.equal(b.status, 'working');
});

test('a merge or reviewer after the worker started still applies', () => {
  const w = st({ raw: 'done', startedAt: iso(0) });
  assert.equal(resolveStatuses([w], [], [{ task: '1', at: iso(0) }], [])[0].status, 'merged');
  assert.equal(resolveStatuses([w], [st({ agentId: 'r', raw: 'done', report: 'pass', startedAt: iso(5) })], [], [])[0].status, 'passed');
});

test('step paths under the worker worktree are shown relative to it, and touched keeps matching', () => {
  const wt = '/work/.worktrees/x-t3';
  const task = { ...agent, worktree: wt, files: ['lib/a.js'] };
  const lines = [
    tool('Edit', { file_path: `${wt}/lib/a.js` }, 1),
    tool('Read', { file_path: `${wt}-other/lib/b.js` }, 2),
    tool('Read', { file_path: '/elsewhere/c.js' }, 3),
  ];
  const { state } = workerState(task, read(lines, 3), null, undefined, opts(4));
  assert.deepEqual(state.steps.map((s) => s.text), ['lib/a.js', `${wt}-other/lib/b.js`, '/elsewhere/c.js']);
  assert.deepEqual(state.edited, [`${wt}/lib/a.js`]);
  assert.deepEqual(state.touched, [`${wt}/lib/a.js`]);
});
