'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { workerState, resolveStatuses, groupWaves } = require('../lib/orchestrations/workers.js');
const { stepsOf } = require('../lib/transcript-index.js');

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
// The lines cache keeps one array while a file grows and raises version on each change.
// A test grows its array in place, so the line count stands in for the version.
const read = (lines, mtimeSec) => ({ lines, mtimeMs: T0 + mtimeSec * 1000, version: lines.length });

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
  // The meta flag shows done at once. watchEvents settles one poll later and adds the DONE event.
  const first = workerState(agent, read(lines, 2), { finished: true }, undefined, opts(3));
  assert.equal(first.state.raw, 'done');
  assert.equal(first.state.report, null);
  assert.equal(first.state.events.some((e) => e.type === 'DONE'), false);
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
  lines.push(tool('Edit', { file_path: 'other.js' }, 4));
  const third = workerState(agent, read(lines, 4), null, second.seen, opts(5));
  assert.equal(third.state.events.length, 2);
});

const st = (over) => ({ agentId: 'w', task: '1', raw: 'working', settled: true, report: null, steps: [], events: [], quiet: false, startedAt: iso(0), lastActiveAt: iso(1), ...over });

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

test('a finished meta flag with a coordinator message last is not done', () => {
  const msg = JSON.stringify({ type: 'user', timestamp: iso(3), origin: { kind: 'coordinator' }, message: { role: 'user', content: 'The coordinator sent a message while you were working:\nGo on.' } });
  const lines = [tool('Read', { file_path: 'a.js' }, 1), text('Done.', 2), msg];
  const { state } = workerState(agent, read(lines, 3), { finished: true }, undefined, opts(4));
  assert.equal(state.lastIsMsg, true);
  assert.equal(state.raw, 'working');
});

const usage = (n) => ({ input_tokens: 1, cache_read_input_tokens: n });
const spyOn = (calls) => (lines, from, to, ctx) => {
  calls.push([from, to]);
  return stepsOf(lines, from, to, ctx);
};

test('a second poll with no new lines does not run stepsOf again', () => {
  const calls = [];
  const lines = [tool('Read', { file_path: 'a.js' }, 1, usage(500))];
  const o = { stepsOf: spyOn(calls) };
  const first = workerState(agent, read(lines, 1), null, undefined, { ...opts(2), ...o });
  const second = workerState(agent, read(lines, 1), null, first.seen, { ...opts(3), ...o, memo: first.memo });
  assert.equal(calls.length, 1);
  assert.deepEqual(second.state, first.state);
});

test('growth runs stepsOf over the appended lines only, and the result equals a full recompute', () => {
  const calls = [];
  const o = { stepsOf: spyOn(calls) };
  const lines = [tool('Read', { file_path: 'a.js' }, 1, usage(500))];
  const first = workerState(agent, read(lines, 1), null, undefined, { ...opts(2), ...o });
  lines.push(tool('Edit', { file_path: 'lib/orchestrations/workers.js' }, 3, usage(900)), ...failure(4));
  const grown = workerState(agent, read(lines, 4), null, first.seen, { ...opts(5), ...o, memo: first.memo });
  assert.deepEqual(calls, [[1, 1], [2, 4]]);
  const full = workerState(agent, read(lines, 4), null, undefined, opts(5)).state;
  for (const key of ['steps', 'current', 'edited', 'touched', 'contextTokens', 'lastIsMsg', 'lastActiveAt', 'raw']) assert.deepEqual(grown.state[key], full[key], key);
  assert.equal(grown.state.contextTokens, 901);
  assert.equal(grown.state.steps.length, 4);
});

test('growth parses only the appended lines', (t) => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(tool('Read', { file_path: `f${i}.js` }, i, usage(500 + i)));
  const first = workerState(agent, read(lines, 40), null, undefined, opts(41));
  lines.push(tool('Read', { file_path: 'g.js' }, 41, usage(900)), tool('Read', { file_path: 'h.js' }, 42, usage(901)));
  const parse = t.mock.method(JSON, 'parse');
  workerState(agent, read(lines, 42), null, first.seen, { ...opts(43), memo: first.memo });
  assert.ok(parse.mock.callCount() < 12, `parsed ${parse.mock.callCount()} lines for 2 appended`);
});

test('an error result in a later batch finds its tool_use from an earlier batch', () => {
  const lines = [tool('Bash', { command: 'npm test' }, 1)];
  const first = workerState(agent, read(lines, 1), null, undefined, opts(2));
  lines.push(JSON.stringify({ type: 'user', timestamp: iso(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'id1', is_error: true, content: 'boom' }] } }));
  const grown = workerState(agent, read(lines, 3), null, first.seen, { ...opts(4), memo: first.memo });
  const full = workerState(agent, read(lines, 3), null, undefined, opts(4)).state;
  assert.deepEqual(grown.state.steps, full.steps);
  assert.equal(grown.state.steps.at(-1).kind, 'error');
  assert.equal(grown.state.steps.at(-1).tool, 'Bash');
});

test('the steps memo keeps only the last 8 steps, not every step', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(tool('Read', { file_path: `f${i}.js` }, i));
  const { memo } = workerState(agent, read(lines, 30), null, undefined, opts(31));
  assert.equal(memo.recent.length, 8);
  assert.equal(memo.lines.deref(), lines);
});

test('a worker transcript that shrank starts its state over', () => {
  const lines = [tool('Edit', { file_path: 'a.js' }, 1), tool('Edit', { file_path: 'b.js' }, 2), tool('Edit', { file_path: 'c.js' }, 3)];
  const first = workerState(agent, { lines, mtimeMs: T0, version: 1 }, null, undefined, opts(4));
  assert.equal(first.state.events.length, 3);
  // The lines cache replaces its array when a file starts over.
  const again = [tool('Edit', { file_path: 'd.js' }, 5)];
  const reset = workerState(agent, { lines: again, mtimeMs: T0, version: 2 }, null, first.seen, { ...opts(6), memo: first.memo });
  assert.deepEqual(reset.state.events.map((e) => e.text), ['DRIFT edit outside task files: d.js']);
  assert.deepEqual(reset.state.edited, ['d.js']);
  assert.equal(reset.state.steps.length, 1);
  // The same array cut short is a reset too.
  lines.splice(1);
  const cut = workerState(agent, { lines, mtimeMs: T0, version: 3 }, null, first.seen, { ...opts(6), memo: first.memo });
  assert.deepEqual(cut.state.events.map((e) => e.text.includes('a.js')), [true]);
  assert.equal(cut.seen.next, 2);
  lines.push(tool('Edit', { file_path: 'e.js' }, 7));
  const next = workerState(agent, { lines, mtimeMs: T0, version: 4 }, null, cut.seen, { ...opts(8), memo: cut.memo });
  assert.equal(next.state.events.length, 2);
});

test('an emptied transcript after a shrink is starting, with no old events', () => {
  const lines = [tool('Edit', { file_path: 'a.js' }, 1)];
  const first = workerState(agent, { lines, mtimeMs: T0, version: 1 }, null, undefined, opts(2));
  const empty = workerState(agent, { lines: [], mtimeMs: T0, version: 2 }, null, first.seen, opts(3));
  assert.equal(empty.state.raw, 'starting');
  assert.deepEqual(empty.state.events, []);
  assert.equal(empty.seen, undefined);
});

test('a detail seen that lags the memo still gets every event, parsing only from its own next line', () => {
  const calls = [];
  const o = { stepsOf: spyOn(calls) };
  const lines = [tool('Edit', { file_path: 'a.js' }, 1)];
  // A list poll advances the memo; the detail seen has not been polled since.
  const listed = workerState(agent, read(lines, 1), null, undefined, { ...opts(2), ...o });
  lines.push(tool('Edit', { file_path: 'b.js' }, 3));
  const memoOnly = workerState(agent, read(lines, 2), null, listed.seen, { ...opts(4), ...o, memo: listed.memo });
  const detail = workerState(agent, read(lines, 2), null, listed.seen, { ...opts(5), ...o, memo: memoOnly.memo });
  assert.equal(detail.state.events.length, 2);
  assert.deepEqual(calls.at(-1), [2, 2]);
});

test('a worker with the finished flag and no transcript lines is done, not starting', () => {
  assert.equal(workerState(agent, read([], 0), { finished: true }, undefined, opts(1)).state.raw, 'done');
  assert.equal(workerState(agent, null, { finished: true }, undefined, opts(1)).state.raw, 'done');
  assert.equal(workerState(agent, null, null, undefined, opts(1)).state.raw, 'starting');
});

test('a reviewer whose flag is set before its handback line is running, then takes the verdict', () => {
  const lines = [text('Reading the diff now.', 1)];
  const w = st({ raw: 'done', task: agent.task });
  const early = workerState({ ...agent, agentId: 'r' }, read(lines, 1), { finished: true }, undefined, opts(2));
  assert.equal(early.state.raw, 'done');
  assert.equal(early.state.settled, false);
  assert.equal(early.state.report, null);
  assert.equal(resolveStatuses([w], [early.state], [], [])[0].status, 'review');
  lines.push(tool('SubagentHandback', { message: 'Pass - looks good' }, 3));
  const late = workerState({ ...agent, agentId: 'r' }, read(lines, 2), { finished: true }, early.seen, { ...opts(4), memo: early.memo });
  assert.equal(late.state.settled, true);
  assert.equal(late.state.report, 'Pass - looks good');
  assert.equal(resolveStatuses([w], [late.state], [], [])[0].status, 'passed');
});

test('a STUCK event carries the time of the failing step, not of the last step', () => {
  const lines = [...failure(1), ...failure(2), ...failure(3), tool('Read', { file_path: 'a.js' }, 9)];
  const { state } = workerState(agent, read(lines, 9), null, undefined, opts(10));
  const stuck = state.events.find((e) => e.type === 'STUCK');
  assert.equal(stuck.at, iso(3));
});

test('a MSG event carries the time of its message line', () => {
  const msg = JSON.stringify({ type: 'user', timestamp: iso(5), origin: { kind: 'coordinator' }, message: { role: 'user', content: 'The coordinator sent a message while you were working:\nGo on.' } });
  const lines = [tool('Read', { file_path: 'a.js' }, 1), msg, tool('Read', { file_path: 'b.js' }, 9)];
  const { state } = workerState(agent, read(lines, 9), null, undefined, opts(10));
  const m = state.events.find((e) => e.type === 'MSG');
  assert.equal(m.line, 2);
  assert.equal(m.at, iso(5));
});

test('a worker with no startedAt goes last and joins the current wave', () => {
  const w = (id, sec, status, lastSec = sec + 10) => ({ agentId: id, startedAt: sec == null ? undefined : iso(sec), lastActiveAt: iso(lastSec ?? 0), status });
  const single = groupWaves([w('x', null, 'working', 5), w('a', 0, 'working')]);
  assert.equal(single.length, 1);
  assert.deepEqual(single[0].workers.map((x) => x.agentId), ['a', 'x']);
  assert.equal(single[0].startedAt, iso(0));
  const second = groupWaves([w('x', null, 'working', 5), w('b', 100, 'working'), w('a', 0, 'merged', 10)]);
  assert.deepEqual(second.map((x) => x.workers.map((y) => y.agentId)), [['a'], ['b', 'x']]);
  const only = groupWaves([w('x', null, 'working', 5), w('y', null, 'done', 6)]);
  assert.equal(only.length, 1);
  assert.equal(only[0].workers.length, 2);
});

test('with no startedAt on the worker, a reviewer or merge of its task still applies', () => {
  const w = st({ raw: 'done', startedAt: undefined });
  assert.equal(resolveStatuses([w], [st({ agentId: 'r', raw: 'done', report: 'pass', startedAt: iso(5) })], [], [])[0].status, 'passed');
  assert.equal(resolveStatuses([w], [], [{ task: '1', at: iso(0) }], [])[0].status, 'merged');
});
