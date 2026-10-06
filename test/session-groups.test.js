'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { groupSessions, itemCost, costShare, runningSessions, activityLabel, doingNow } = require('../public/session-groups');

function session(project, lastActiveAt, overrides = {}) {
  return {
    project, costUsd: 1, costTodayUsd: 0.5, durationMs: 1000, linesAdded: 2, linesRemoved: 1,
    tokens: 100, prompts: 3, spans: [], lastActiveAt, ended: 'clear', live: false, ...overrides,
  };
}

test('two ended sessions of one project become a group', () => {
  const items = groupSessions([session('a', 20), session('a', 10)]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, 'group');
  assert.strictEqual(items[0].project, 'a');
  assert.strictEqual(items[0].sessions.length, 2);
});

test('a single ended session of a project stays a plain item', () => {
  const s = session('a', 10);
  assert.deepStrictEqual(groupSessions([s]), [{ type: 'session', session: s }]);
});

test('live and idle open sessions are never grouped', () => {
  const sessions = [
    session('a', 30, { ended: null, live: true }),
    session('a', 20, { ended: null }),
    session('a', 10),
  ];
  assert.deepStrictEqual(groupSessions(sessions).map((i) => i.type), ['session', 'session', 'session']);
});

test('ended sessions group even when open sessions of the project exist', () => {
  const items = groupSessions([session('a', 30, { ended: null, live: true, costTodayUsd: 5 }), session('a', 20), session('a', 10)]);
  assert.deepStrictEqual(items.map((i) => i.type), ['session', 'group']);
});

test('group fields sum the sessions and take the newest lastActiveAt', () => {
  const [g] = groupSessions([session('a', 20), session('a', 10, { costUsd: 2, tokens: 50 })]);
  assert.strictEqual(g.costUsd, 3);
  assert.strictEqual(g.costTodayUsd, 1);
  assert.strictEqual(g.durationMs, 2000);
  assert.strictEqual(g.linesAdded, 4);
  assert.strictEqual(g.linesRemoved, 2);
  assert.strictEqual(g.tokens, 150);
  assert.strictEqual(g.prompts, 6);
  assert.strictEqual(g.lastActiveAt, 20);
});

test('rows are sorted by Cost today, highest first, and a group counts by its summed cost', () => {
  const items = groupSessions([
    session('a', 50, { ended: null, live: true, costTodayUsd: 0.4 }),
    session('b', 40, { costTodayUsd: 0.3 }),
    session('c', 30, { ended: null, costTodayUsd: 0.9 }),
    session('b', 20, { costTodayUsd: 0.3 }),
  ]);
  // c: 0.9, group b: 0.6, a: 0.4
  assert.deepStrictEqual(items.map((i) => i.type), ['session', 'group', 'session']);
  assert.deepStrictEqual(items.map((i) => i.type === 'group' ? i.project : i.session.project), ['c', 'b', 'a']);
});

test('rows with equal Cost today are ordered newest lastActiveAt first, including when every cost is 0', () => {
  const items = groupSessions([
    session('a', 10, { ended: null, costTodayUsd: 0 }),
    session('b', 30, { ended: null, costTodayUsd: 0 }),
    session('c', 20, { ended: null, costTodayUsd: 0 }),
  ]);
  assert.deepStrictEqual(items.map((i) => i.session.project), ['b', 'c', 'a']);
});

test('itemCost reads a plain row and a group the same way', () => {
  const [g] = groupSessions([session('a', 20), session('a', 10)]);
  assert.strictEqual(itemCost(g), 1);
  assert.strictEqual(itemCost({ type: 'session', session: session('b', 1, { costTodayUsd: 2.5 }) }), 2.5);
});

test('costShare is the value over the maximum, clamped, and 0 when the maximum is 0', () => {
  assert.strictEqual(costShare(2, 8), 0.25);
  assert.strictEqual(costShare(9, 8), 1);
  assert.strictEqual(costShare(0, 0), 0);
  assert.strictEqual(costShare(1, 0), 0);
  assert.strictEqual(costShare(-1, 8), 0);
});

test('runningSessions keeps live sessions only, ordered by first span start', () => {
  const a = session('a', 100, { ended: null, live: true, spans: [[500, 600]] });
  const b = session('b', 90, { ended: null, live: true, spans: [[100, 200], [400, 450]] });
  const idle = session('c', 80, { ended: null, live: false, spans: [[1, 2]] });
  const done = session('d', 70, { spans: [[1, 2]] });
  assert.deepStrictEqual(runningSessions([a, idle, b, done]).map((s) => s.project), ['b', 'a']);
});

test('runningSessions puts a session with no span last, and breaks ties by newest lastActiveAt', () => {
  const none = session('none', 100, { ended: null, live: true, spans: [] });
  const tieOld = session('tie-old', 10, { ended: null, live: true, spans: [[100, 100]] });
  const tieNew = session('tie-new', 20, { ended: null, live: true, spans: [[100, 100]] });
  assert.deepStrictEqual(runningSessions([none, tieOld, tieNew]).map((s) => s.project), ['tie-new', 'tie-old', 'none']);
});

test('runningSessions sorts a live session without a spans array last and does not throw', () => {
  const noSpans = session('no-spans', 100, { ended: null, live: true });
  delete noSpans.spans;
  const withSpan = session('with-span', 10, { ended: null, live: true, spans: [[100, 100]] });
  assert.deepStrictEqual(runningSessions([noSpans, withSpan]).map((s) => s.project), ['with-span', 'no-spans']);
});

test('runningSessions returns [] when no session is live', () => {
  assert.deepStrictEqual(runningSessions([session('a', 1)]), []);
});

test('a group keeps its sessions in incoming order', () => {
  const [g] = groupSessions([session('a', 30), session('a', 20), session('a', 10)]);
  assert.deepStrictEqual(g.sessions.map((s) => s.lastActiveAt), [30, 20, 10]);
});

test('cleared counts ended === clear and ended counts every other end', () => {
  const [g] = groupSessions([
    session('a', 30), session('a', 20, { ended: 'other' }), session('a', 10, { ended: 'logout' }),
  ]);
  assert.strictEqual(g.cleared, 1);
  assert.strictEqual(g.ended, 2);
});

test('sessions with a null project group together', () => {
  const [g] = groupSessions([session(null, 20), session(null, 10)]);
  assert.strictEqual(g.type, 'group');
  assert.strictEqual(g.project, null);
});

test('activityLabel gives each state its own glyph and words, so no state depends on colour', () => {
  assert.deepStrictEqual(activityLabel({ state: 'working' }), { glyph: '▶', label: 'working', attention: false, text: '▶ working' });
  assert.deepStrictEqual(activityLabel({ state: 'waiting' }), { glyph: '⏸', label: 'waiting on you', attention: true, text: '⏸ waiting on you' });
  assert.deepStrictEqual(activityLabel({ state: 'approval' }), { glyph: '⚠', label: 'needs approval', attention: true, text: '⚠ needs approval' });
});

test('activityLabel is null without activity or with an unknown state', () => {
  assert.strictEqual(activityLabel(null), null);
  assert.strictEqual(activityLabel(undefined), null);
  assert.strictEqual(activityLabel({ state: 'constructor' }), null);
});

test('doingNow shows the tool with its detail, and the subagent count when there is one', () => {
  const tool = { name: 'Bash', detail: 'npm test', startedAt: 1 };
  assert.strictEqual(doingNow({ state: 'working', tool, subagents: 0 }), 'Bash: npm test');
  assert.strictEqual(doingNow({ state: 'working', tool: { ...tool, detail: '' }, subagents: 0 }), 'Bash');
  assert.strictEqual(doingNow({ state: 'working', tool, subagents: 2 }), 'Bash: npm test · 2 subagents');
  assert.strictEqual(doingNow({ state: 'working', tool: null, subagents: 1 }), '1 subagent');
});

test('doingNow is null with no activity, or nothing running', () => {
  assert.strictEqual(doingNow(null), null);
  assert.strictEqual(doingNow({ state: 'waiting', tool: null, subagents: 0 }), null);
});

test('runningSessions keeps a session that is waiting on you after it stops being live', () => {
  const base = { spans: [[1, 2]], lastActiveAt: 2, live: false };
  const waiting = { ...base, project: 'waiting', activity: { state: 'waiting' } };
  const approval = { ...base, project: 'approval', spans: [[3, 4]], activity: { state: 'approval' } };
  const stale = { ...base, project: 'stale', activity: null };
  const working = { ...base, project: 'working', activity: { state: 'working' } };
  assert.deepStrictEqual(runningSessions([stale, approval, working, waiting]).map((s) => s.project), ['waiting', 'approval']);
});
