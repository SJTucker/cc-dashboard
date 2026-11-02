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

const who = { authorTime: 100, authorEmail: 'a@b' };

test('lineRows counts an amend as its difference from the commit it amended', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3, ...who });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4, amend: true, ...who });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(3, 2, 1), row(1, 0, 2)]);
});

test('lineRows keeps sibling commits that share a parent', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3 });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4 });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(3, 2, 1), row(4, 2, 2)]);
});

test('lineRows subtracts the amended commit of the same worktree, not a sibling in another worktree', () => {
  const a1 = commit({ sha: 'a'.repeat(40), t: 1, added: 3, toplevel: '/wt/a', ...who });
  const b1 = commit({ sha: 'b'.repeat(40), t: 2, added: 4, toplevel: '/wt/b', authorTime: 200, authorEmail: 'a@b' });
  const a2 = commit({ sha: 'c'.repeat(40), t: 3, added: 5, toplevel: '/wt/a', amend: true, ...who });
  assert.deepStrictEqual(lineRows([], [a1, b1, a2]), [row(3, 2, 1), row(4, 2, 2), row(2, 0, 3)]);
});

test('lineRows leaves a commit its lines when the amend is in another session', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3, ...who });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4, amend: true, sessionId: 's2', ...who });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(3, 2, 1), row(1, 0, 2, 's2')]);
});

test('lineRows lets an amended commit keep covering an edit', () => {
  const a1 = commit({ sha: 'a'.repeat(40), t: 2, files: ['/r/a.js'], added: 3, ...who });
  const a2 = commit({ sha: 'b'.repeat(40), t: 4, files: ['/r/b.js'], added: 6, amend: true, ...who });
  assert.deepStrictEqual(lineRows([edit({ t: 1, file: '/r/a.js' })], [a1, a2]), [row(3, 2, 2), row(3, 0, 4)]);
});

test('lineRows dedupes a duplicate sha before the amend search', () => {
  const a = commit({ sha: 'a'.repeat(40), t: 1, added: 3, ...who });
  const b = commit({ sha: 'b'.repeat(40), t: 2, added: 4, amend: true, ...who });
  assert.deepStrictEqual(lineRows([], [a, a, b]), [row(3, 2, 1), row(1, 0, 2)]);
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
  assert.deepStrictEqual(rows.map((r) => [r.sessionId, r.added]), [['s1', 5], ['s2', 2]]);
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

const sha = (c) => c.repeat(40);

test('a rebased copy with the same patchId counts once', () => {
  const a = commit({ sha: sha('a'), t: 5, patchId: 'P', authorTime: 1, authorEmail: 'x@y' });
  const b = commit({ sha: sha('b'), t: 3, patchId: 'P', authorTime: 2, authorEmail: 'x@y' });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(10, 2, 3)]);
});

test('an amend and its rebased copy count once', () => {
  const am = commit({ sha: sha('a'), t: 3, amend: true, patchId: 'P' });
  const copy = commit({ sha: sha('b'), t: 6, patchId: 'P' });
  assert.deepStrictEqual(lineRows([], [am, copy]), [row(10, 2, 3)]);
});

test('rows without patchId fall back to the author key', () => {
  const o = { authorTime: 500, authorEmail: 'x@y', subject: 'feat' };
  const a = commit({ sha: sha('a'), t: 2, ...o });
  const b = commit({ sha: sha('b'), t: 1, ...o });
  assert.deepStrictEqual(lineRows([], [a, b]), [row(10, 2, 1)]);
});

test('an amend counts its reflog delta', () => {
  const o = commit({ sha: sha('a'), t: 1, added: 10, removed: 0, ...who });
  const a = commit({ sha: sha('b'), t: 2, added: 13, removed: 0, amend: true, sessionId: 's2', amendOf: { sha: o.sha, added: 3, removed: 0 }, ...who });
  assert.deepStrictEqual(lineRows([], [o, a]), [row(10, 0, 1), row(3, 0, 2, 's2')]);
});

test('an amend without amendOf counts the difference from its matched original', () => {
  const o = commit({ sha: sha('a'), t: 1, added: 10, removed: 0, ...who });
  const a = commit({ sha: sha('b'), t: 2, added: 25, removed: 0, amend: true, sessionId: 's2', ...who });
  assert.deepStrictEqual(lineRows([], [o, a]), [row(10, 0, 1), row(15, 0, 2, 's2')]);
  assert.deepStrictEqual(lineRows([], [a]), [row(25, 0, 2, 's2')], 'no original: counts in full');
});

test('a same-session amend chain counts the final content once', () => {
  const c1 = commit({ sha: sha('1'), t: 1, added: 10, removed: 0, ...who });
  const c2 = commit({ sha: sha('2'), t: 2, added: 12, removed: 0, amend: true, ...who });
  const c3 = commit({ sha: sha('3'), t: 3, added: 15, removed: 0, amend: true, ...who });
  const rows = lineRows([], [c1, c2, c3]);
  assert.strictEqual(rows.reduce((n, r) => n + r.added, 0), 15);
});

test('a squash commit counts 0 and does not cover edits', () => {
  const e = edit({ t: 1, file: '/r/f', root: '/r' });
  const sq = commit({ sha: sha('a'), t: 2, squash: true, files: ['f'], toplevel: '/r' });
  assert.deepStrictEqual(lineRows([e], [sq]), [row(5, 1, 1)]);
});

test('matches an edit in a removed worktree to a fallback commit by repo and path', () => {
  const e = edit({ t: 1, file: '/r.wt/src/a.js', root: '/r.wt', repo: '/r' });
  const c = commit({ t: 2, toplevel: '/r', fallback: true, repo: '/r', files: ['src/a.js'] });
  assert.deepStrictEqual(lineRows([e], [c]), [row(10, 2, 2)]);
});

test('a live-worktree commit does not cover the same path edited in another worktree', () => {
  const e = edit({ t: 1, file: '/r.a/src/a.js', root: '/r.a' });
  const c = commit({ t: 2, toplevel: '/r.b', files: ['src/a.js'] });
  assert.deepStrictEqual(lineRows([e], [c]), [row(5, 1, 1), row(10, 2, 2)]);
});

test('an amend of a patch-id copy subtracts the dropped copy and emits only the kept row', () => {
  const c = commit({ sha: sha('a'), t: 1, parent: 'P1', patchId: 'X', added: 10, removed: 0, ...who });
  const copy = commit({ sha: sha('b'), t: 2, parent: 'P2', patchId: 'X', added: 10, removed: 0, ...who });
  const a = commit({ sha: sha('c'), t: 3, parent: 'P2', amend: true, added: 14, removed: 0, ...who });
  assert.deepStrictEqual(lineRows([], [c, copy, a]), [row(10, 0, 1), row(4, 0, 3)]);
});

test('a fallback commit covers an edit of its own removed worktree only', () => {
  const c = commit({ t: 2, toplevel: '/r', root: '/r.b', fallback: true, files: ['src/a.js'] });
  const other = edit({ t: 1, file: '/r.a/src/a.js', root: '/r.a' });
  const own = edit({ t: 1, file: '/r.b/src/a.js', root: '/r.b' });
  assert.deepStrictEqual(lineRows([other], [c]), [row(5, 1, 1), row(10, 2, 2)]);
  assert.deepStrictEqual(lineRows([own], [c]), [row(10, 2, 2)]);
});

test('an edit outside its root still matches by absolute path', () => {
  const e = edit({ t: 1, file: '/elsewhere/a.js', root: '/r' });
  const c = commit({ t: 2, files: ['a.js'], toplevel: '/elsewhere' });
  assert.deepStrictEqual(lineRows([e], [c]), [row(10, 2, 2)]);
});

test('an amend of a squash-marked original counts only its delta', () => {
  const o = commit({ sha: sha('a'), t: 1, squash: true, added: 10, removed: 0, ...who });
  const a = commit({ sha: sha('b'), t: 2, amend: true, added: 12, removed: 0, ...who });
  assert.deepStrictEqual(lineRows([], [o, a]), [row(2, 0, 2)]);
});

test('an amend with amendOf and no original row counts in full', () => {
  const a = commit({ sha: sha('b'), t: 2, amend: true, added: 40, removed: 0, amendOf: { sha: sha('z'), added: 3, removed: 1 }, ...who });
  assert.deepStrictEqual(lineRows([], [a]), [row(40, 0, 2)]);
});

test('a reflog row and its amend with amendOf count the original in full plus the delta', () => {
  const c1 = commit({ sha: sha('a'), t: 1, added: 30, removed: 20, fromReflog: true, ...who });
  const c2 = commit({ sha: sha('b'), t: 2, added: 33, removed: 24, amend: true, amendOf: { sha: c1.sha, added: 3, removed: 4 }, ...who, subject: 'reworded' });
  assert.deepStrictEqual(lineRows([], [c1, c2]), [row(30, 20, 1), row(3, 4, 2)]);
});

const rf = { authorTime: 500, authorEmail: 'x@y', subject: 'work', files: ['a.js', 'b.js'] };

test('a reflog row is dropped when a counted row shares its author time, author and subject', () => {
  const r = commit({ sha: sha('a'), t: 1, fromReflog: true, ...rf });
  const c = commit({ sha: sha('b'), t: 2, added: 7, removed: 1, patchId: 'P', ...rf });
  assert.deepStrictEqual(lineRows([], [r, c]), [row(7, 1, 2)]);
});

test('a reflog row is dropped when a counted row has its subject, author and files at another author time', () => {
  const r = commit({ sha: sha('a'), t: 1, fromReflog: true, ...rf });
  const c = commit({ sha: sha('b'), t: 2, added: 7, removed: 1, patchId: 'P', ...rf, authorTime: 900, files: ['b.js', 'a.js'] });
  assert.deepStrictEqual(lineRows([], [r, c]), [row(7, 1, 2)]);
});

test('a reflog row with no twin counts', () => {
  const r = commit({ sha: sha('a'), t: 1, fromReflog: true, patchId: 'Q', ...rf });
  const c = commit({ sha: sha('b'), t: 2, added: 7, removed: 1, patchId: 'P', ...rf, authorTime: 900, subject: 'other' });
  assert.deepStrictEqual(lineRows([], [r, c]), [row(10, 2, 1), row(7, 1, 2)]);
});

test('an amend of a dropped reflog row counts in full', () => {
  const r = commit({ sha: sha('a'), t: 1, fromReflog: true, ...rf });
  const c = commit({ sha: sha('c'), t: 2, added: 7, removed: 1, patchId: 'P', ...rf });
  const a = commit({ sha: sha('b'), t: 3, added: 40, removed: 5, amend: true, amendOf: { sha: r.sha, added: 3, removed: 1 }, authorTime: 600, subject: 'amended', files: ['z.js'], authorEmail: 'x@y' });
  assert.deepStrictEqual(lineRows([], [r, c, a]), [row(7, 1, 2), row(40, 5, 3)]);
});

test('a patch-id copy of a twin-dropped reflog row is not an original for a later amend', () => {
  // fac6bb95: R and its patch-id copy P are reflog rows. C (reachable amend) shares their author key.
  const r = commit({ sha: sha('a'), t: 1, fromReflog: true, patchId: 'X', ...rf, added: 65, removed: 10 });
  const p = commit({ sha: sha('b'), t: 2, fromReflog: true, amend: true, patchId: 'X', ...rf, added: 65, removed: 10 });
  const c = commit({ sha: sha('c'), t: 3, amend: true, patchId: 'Y', ...rf, added: 66, removed: 10, parent: 'p', amendOf: { sha: p.sha, added: 1, removed: 0 } });
  assert.deepStrictEqual(lineRows([], [r, p, c]), [row(66, 10, 3)]);
});

test('a rewrite row whose original row exists is dropped', () => {
  const o = commit({ sha: sha('a'), t: 1, patchId: 'P', ...rf });
  const w = commit({ sha: sha('b'), t: 2, rewrite: true, patchId: 'P', ...rf, authorTime: 100 });
  assert.deepStrictEqual(lineRows([], [o, w]), [row(10, 2, 1)]);
  const w2 = commit({ sha: sha('c'), t: 2, rewrite: true, patchId: 'Z', ...rf, authorTime: 100 });
  assert.deepStrictEqual(lineRows([], [o, w2]), [row(10, 2, 1)]);
});

test('a rewrite row with no twin counts', () => {
  const o = commit({ sha: sha('a'), t: 1, patchId: 'P', ...rf, subject: 'other', files: ['q.js'] });
  const w = commit({ sha: sha('b'), t: 2, rewrite: true, patchId: 'Z', ...rf, authorTime: 100 });
  assert.deepStrictEqual(lineRows([], [o, w]), [row(10, 2, 1), row(10, 2, 2)]);
});

test('a reflog row sharing subject, author and one file with a counted row is dropped', () => {
  const c = commit({ sha: sha('a'), t: 2, patchId: 'P', ...rf, authorTime: 900, files: ['a.js', 'c.js'] });
  const r = commit({ sha: sha('b'), t: 1, fromReflog: true, patchId: 'Q', ...rf, files: ['a.js', 'b.js'] });
  assert.deepStrictEqual(lineRows([], [r, c]), [row(10, 2, 2)]);
  const r2 = commit({ sha: sha('d'), t: 1, fromReflog: true, patchId: 'R', ...rf, files: ['x.js'] });
  assert.deepStrictEqual(lineRows([], [r2, c]), [row(10, 2, 1), row(10, 2, 2)]);
});

test('a rewrite row with author other than committer counts when the author has a counted row in the repo', () => {
  const o = commit({ sha: sha('a'), t: 1, patchId: 'P', ...rf, authorEmail: 'me@x', subject: 'mine', files: ['q.js'] });
  const w = commit({ sha: sha('b'), t: 2, rewrite: true, patchId: 'Z', ...rf, authorEmail: 'me@x', committerEmail: 'other@x', authorTime: 100, subject: 'copied' });
  assert.deepStrictEqual(lineRows([], [o, w]), [row(10, 2, 1), row(10, 2, 2)]);
});

test('a rewrite row whose author email appears nowhere is dropped', () => {
  const o = commit({ sha: sha('a'), t: 1, patchId: 'P', ...rf, authorEmail: 'me@x', subject: 'mine', files: ['q.js'] });
  const w = commit({ sha: sha('b'), t: 2, rewrite: true, patchId: 'Z', ...rf, authorEmail: 'them@x', committerEmail: 'me@x2', authorTime: 100, subject: 'copied' });
  assert.deepStrictEqual(lineRows([], [o, w]), [row(10, 2, 1)]);
});

const cov = (id, files, o = {}) => commit({ sha: sha(id), t: 1, patchId: 'P' + id, files, authorEmail: 'me@x', authorTime: 600, subject: 'part ' + id, ...o });

test('a rewrite row whose files are all covered by later-authored counted commits is dropped', () => {
  const w = commit({ sha: sha('w'), t: 5, rewrite: true, patchId: 'W', authorEmail: 'me@x', committerEmail: 'me@x', authorTime: 500, subject: 'squash', files: ['a.js', 'b.js'] });
  assert.deepStrictEqual(lineRows([], [cov('a', ['a.js']), cov('b', ['b.js'], { authorTime: 700 }), w]).length, 2);
});

test('a rewrite row with one uncovered file counts', () => {
  const w = commit({ sha: sha('w'), t: 5, rewrite: true, patchId: 'W', authorEmail: 'me@x', committerEmail: 'me@x', authorTime: 500, subject: 'squash', files: ['a.js', 'c.js'] });
  assert.strictEqual(lineRows([], [cov('a', ['a.js']), cov('b', ['b.js']), w]).length, 3);
});

test('a reflog row covered the same way is dropped, and an earlier-authored cover does not count', () => {
  const w = commit({ sha: sha('w'), t: 5, fromReflog: true, patchId: 'W', authorEmail: 'me@x', authorTime: 500, subject: 'squash', files: ['a.js', 'b.js'] });
  assert.strictEqual(lineRows([], [cov('a', ['a.js']), cov('b', ['b.js']), w]).length, 2);
  const early = commit({ sha: sha('w'), t: 5, fromReflog: true, patchId: 'W', authorEmail: 'me@x', authorTime: 650, subject: 'squash', files: ['a.js', 'b.js'] });
  assert.strictEqual(lineRows([], [cov('a', ['a.js']), cov('b', ['b.js']), early]).length, 3);
});
