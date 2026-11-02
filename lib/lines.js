'use strict';

const { relative, isAbsolute } = require('node:path');

// The line rows behind the lines totals: Edit and Write rows plus commit rows.
// A session's edits and the commit that records them describe the same lines, so
// lineRows counts them once, from the commit.
//
//
// Rows migrated from older versions can lack patchId, amendOf, squash, fallback or
// root. A missing field means unknown, and each step falls back to the older rule.

// edits: { toolUseId, t, sessionId, added, removed, repo, file, root }
// commits: { sha, parent, added, removed, files, repo, toplevel, amend, amendOf, squash, fallback, patchId, authorTime, authorEmail, subject, t, sessionId }
// Returns [{ sessionId, t, added, removed, repo }].
function lineRows(edits, commits) {
  // 1. One row per sha, because a commit seen in two transcripts is one commit.
  const bySha = new Map();
  // A named row (its subject is in the command) beats an unnamed one, because the
  // unnamed row may be another session's commit that `git log --all` returned.
  // Otherwise the earliest `t` wins.
  for (const c of commits) {
    const held = bySha.get(c.sha);
    if (!held || (!!c.named > !!held.named) || (!!c.named === !!held.named && c.t < held.t)) bySha.set(c.sha, c);
  }
  const kept = [...bySha.values()].sort((a, b) => a.t - b.t);

  // 2. A rebase or cherry-pick copies a commit under a new sha. One copy counts, the
  // one with the earliest `t` (`kept` is sorted by `t`, so the first row seen wins).
  // A row with a patchId is keyed by (repo, patchId). A row without one uses
  // (repo, authorTime, authorEmail, subject) and skips amends, because an amend in a
  // later session shares those fields with the commit it rewrote.
  const seen = new Set();
  const unique = kept.filter((c) => {
    let key;
    if (c.patchId) key = `p\0${c.repo}\0${c.patchId}`;
    else if (c.amend || c.authorTime == null || c.authorEmail == null) return true;
    else key = `a\0${c.repo}\0${c.authorTime}\0${c.authorEmail}\0${c.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 3. An amend counts only its own change. With `amendOf` (the reflog delta) that is
  // the delta. Without it, the amend counts its lines minus those of the original: the
  // latest earlier kept row in the same checkout with the same parent, author time and
  // author, from any session. The original keeps its full lines. With no original the
  // amend counts in full. `toplevel` is the worktree's own root, and `repo` is the main
  // checkout for every worktree, so `toplevel` is preferred.
  const latestAt = new Map();
  const counted = [];
  for (const c of unique) {
    const key = c.authorTime == null || c.authorEmail == null
      ? null
      : `${c.toplevel ?? c.repo}\0${c.parent}\0${c.authorTime}\0${c.authorEmail}`;
    let added = c.added;
    let removed = c.removed;
    if (c.amend) {
      if (c.amendOf) {
        added = c.amendOf.added;
        removed = c.amendOf.removed;
      } else {
        const orig = key && latestAt.get(key);
        if (orig) {
          added = Math.max(0, c.added - orig.added);
          removed = Math.max(0, c.removed - orig.removed);
        }
      }
    }
    if (key) latestAt.set(key, c);
    // 4. A squash commit repeats lines its source commits already counted, so it counts 0.
    if (!c.squash) counted.push({ c, added, removed });
  }

  // 5. An edit is covered by a later commit of the same session that lists its file.
  // Per session, three maps give the latest commit `t` for a path, so each edit is a
  // constant number of lookups. `files` are relative to `toplevel`.
  //   byRoot: `${toplevel}\0${file}`, for a commit read from its own checkout.
  //   byRepo: `${repo}\0${file}`, for a fallback commit read from the main checkout
  //     after its worktree was removed.
  //   byAbs: absolute path, for an edit row without `root`.
  const index = new Map();
  const bump = (m, k, t) => { if ((m.get(k) ?? -Infinity) < t) m.set(k, t); };
  for (const { c } of counted) {
    let s = index.get(c.sessionId);
    if (!s) index.set(c.sessionId, (s = { byRoot: new Map(), byRepo: new Map(), byAbs: new Map() }));
    for (const f of c.files) {
      if (c.fallback) bump(s.byRepo, `${c.repo}\0${f}`, c.t);
      else {
        if (c.toplevel) bump(s.byRoot, `${c.toplevel}\0${f}`, c.t);
        bump(s.byAbs, c.toplevel ? `${c.toplevel}/${f}` : f, c.t);
      }
    }
  }
  const covered = (e) => {
    const s = index.get(e.sessionId);
    if (!s || e.file == null || e.t == null) return false;
    if (!e.root) return (s.byAbs.get(e.file) ?? -Infinity) >= e.t;
    const rel = relative(e.root, e.file);
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    return (s.byRoot.get(`${e.root}\0${rel}`) ?? -Infinity) >= e.t
      || (s.byRepo.get(`${e.repo}\0${rel}`) ?? -Infinity) >= e.t;
  };

  const rows = [];
  for (const e of edits) if (!covered(e)) rows.push({ sessionId: e.sessionId, t: e.t, added: e.added, removed: e.removed, repo: e.repo });
  for (const { c, added, removed } of counted) rows.push({ sessionId: c.sessionId, t: c.t, added, removed, repo: c.repo });
  return rows;
}

module.exports = { lineRows };
