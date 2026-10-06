'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { groupSessions } = require('../public/session-groups');

function session(project, lastActiveAt, overrides = {}) {
  return {
    project, costUsd: 1, costTodayUsd: 0.5, durationMs: 1000, linesAdded: 2, linesRemoved: 1,
    tokens: 100, lastActiveAt, ended: 'clear', live: false, ...overrides,
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
  const items = groupSessions([session('a', 30, { ended: null, live: true }), session('a', 20), session('a', 10)]);
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
  assert.strictEqual(g.lastActiveAt, 20);
});

test('a group sits among plain rows by its newest lastActiveAt', () => {
  const items = groupSessions([
    session('a', 50, { ended: null, live: true }),
    session('b', 40),
    session('c', 30, { ended: null }),
    session('b', 20),
  ]);
  assert.deepStrictEqual(items.map((i) => i.type), ['session', 'group', 'session']);
  assert.strictEqual(items[1].project, 'b');
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
