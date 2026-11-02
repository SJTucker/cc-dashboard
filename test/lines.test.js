'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lineRows } = require('../lib/lines');

const edit = (o = {}) => ({ toolUseId: 'e', t: 1, sessionId: 's1', added: 5, removed: 1, repo: '/r', file: '/r/a.js', ...o });
const commit = (o = {}) => ({ sha: 'a'.repeat(40), parent: 'p', added: 10, removed: 2, files: ['/r/a.js'], repo: '/r', amend: false, t: 2, sessionId: 's1', ...o });
const row = (added, removed, t = 1, sessionId = 's1') => ({ sessionId, t, added, removed, repo: '/r' });

test('lineRows keeps edits no commit covers', () => {
  assert.deepStrictEqual(lineRows([edit()], []), [row(5, 1)]);
});

test('lineRows drops an edit a later commit of the same session contains', () => {
  assert.deepStrictEqual(lineRows([edit({ t: 1 })], [commit({ t: 2 })]), [row(10, 2, 2)]);
});

test('lineRows keeps an edit made after the commit', () => {
  assert.deepStrictEqual(lineRows([edit({ t: 3 })], [commit({ t: 2 })]), [row(5, 1, 3), row(10, 2, 2)]);
});

test('lineRows keeps an edit another session committed', () => {
  assert.deepStrictEqual(lineRows([edit()], [commit({ sessionId: 's2' })]), [row(5, 1), row(10, 2, 2, 's2')]);
});

test('lineRows keeps an edit with no file', () => {
  assert.deepStrictEqual(lineRows([edit({ file: undefined })], [commit()]), [row(5, 1), row(10, 2, 2)]);
});

test('lineRows counts each sha once', () => {
  assert.strictEqual(lineRows([], [commit(), commit()]).length, 1);
});

test('lineRows lets an amend replace the commit it amended', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3 });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4, amend: true });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(4, 2, 2)]);
});

test('lineRows keeps sibling commits that share a parent', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3 });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4 });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(3, 2, 1), row(4, 2, 2)]);
});

test('lineRows drops the amended commit, not a sibling in another worktree', () => {
  const a1 = commit({ sha: 'a'.repeat(40), t: 1, added: 3, toplevel: '/wt/a' });
  const b1 = commit({ sha: 'b'.repeat(40), t: 2, added: 4, toplevel: '/wt/b' });
  const a2 = commit({ sha: 'c'.repeat(40), t: 3, added: 5, toplevel: '/wt/a', amend: true });
  assert.deepStrictEqual(lineRows([], [a1, b1, a2]), [row(4, 2, 2), row(5, 2, 3)]);
});

test('lineRows leaves a commit alone when the amend is in another session', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3 });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4, amend: true, sessionId: 's2' });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(3, 2, 1), row(4, 2, 2, 's2')]);
});

test('lineRows does not let an amended-away commit cover an edit', () => {
  const a1 = commit({ sha: 'a'.repeat(40), t: 2, files: ['/r/a.js'], added: 3 });
  const a2 = commit({ sha: 'b'.repeat(40), t: 4, files: ['/r/b.js'], added: 6, amend: true });
  assert.deepStrictEqual(lineRows([edit({ t: 1, file: '/r/a.js' })], [a1, a2]), [row(5, 1, 1), row(6, 2, 4)]);
});

test('lineRows dedupes a duplicate sha before the amend search', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3 });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4, amend: true });
  assert.deepStrictEqual(lineRows([], [a, a, b]), [row(4, 2, 2)]);
});

test('lineRows counts rewritten copies once, keeping the earliest', () => {
  const o = { authorTime: 500, authorEmail: 'x@y', subject: 'feat' };
  const a = commit({ sha: 'a'.repeat(40), t: 2, added: 3, ...o });
  const b = commit({ sha: 'b'.repeat(40), t: 1, added: 3, ...o });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(3, 2, 1)]);
});

test('lineRows keeps a cross-session amend next to the commit it rewrote', () => {
  const c1 = commit({ sha: '1'.repeat(40), sessionId: 's1', t: 2, authorTime: 100, authorEmail: 'a@b', subject: 'x', added: 5 });
  const c2 = commit({ sha: '2'.repeat(40), sessionId: 's2', t: 4, authorTime: 100, authorEmail: 'a@b', subject: 'x', added: 7, amend: true });
  const rows = lineRows([], [c1, c2]);
  assert.deepStrictEqual(rows.map((r) => [r.sessionId, r.added]), [['s1', 5], ['s2', 7]]);
});

test('lineRows keeps the named row when one sha is seen in two sessions', () => {
  const unnamed = commit({ sessionId: 's1', t: 2 });
  const named = commit({ sessionId: 's2', t: 5, named: true });
  for (const input of [[unnamed, named], [named, unnamed]]) {
    const rows = lineRows([], input);
    assert.deepStrictEqual(rows.map((r) => r.sessionId), ['s2']);
  }
});

test('lineRows matches edits against files relative to toplevel', () => {
  const c = commit({ files: ['a.js'], toplevel: '/r', t: 5 });
  const edit = { toolUseId: 'e', t: 3, sessionId: 's1', added: 4, removed: 0, repo: '/r', file: '/r/a.js' };
  assert.deepStrictEqual(lineRows([edit], [c]).map((r) => r.added), [10]);
});
