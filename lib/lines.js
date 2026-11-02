'use strict';

// The line rows behind the lines totals: Edit and Write rows plus commit rows.
// A session's edits and the commit that records them describe the same lines, so
// lineRows counts them once, from the commit.
//
// Known limit: a commit resolved through the deleted-worktree fallback lists
// main-checkout paths, so an edit of the same file is not matched and its lines
// count twice.

// edits: { toolUseId, t, sessionId, added, removed, repo, file }
// commits: { sha, parent, added, removed, files, repo, toplevel, amend, authorTime, authorEmail, subject, t, sessionId }
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

  // 2. An amend replaces the latest earlier commit of its session and checkout that
  // has the same parent. `repo` is the main checkout for every worktree, so the match
  // uses `toplevel` (the worktree's own root) and falls back to `repo` for a row
  // without it. A non-amend commit with that parent is a sibling, so it stays.
  const place = (c) => c.toplevel ?? c.repo;
  const dropped = new Set();
  for (const c of kept) {
    if (!c.amend) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      const p = kept[i];
      if (p === c || dropped.has(p) || p.t > c.t) continue;
      if (p.sessionId === c.sessionId && place(p) === place(c) && p.parent === c.parent) {
        dropped.add(p);
        break;
      }
    }
  }

  // 2b. A rebase or cherry-pick copies a commit under a new sha but keeps its author
  // time, author and subject. One copy counts, the one with the earliest `t`. An amend
  // row is never a copy: an amend in a later session shares those three fields with
  // the commit it rewrote and must keep its own lines.
  // `kept` is sorted by `t`, so the first row seen for a key is the earliest.
  const copies = new Set();
  const commitRows = kept.filter((c) => {
    if (dropped.has(c)) return false;
    if (c.amend) return true;
    if (c.authorTime == null || c.authorEmail == null) return true;
    const key = `${c.authorTime}\0${c.authorEmail}\0${c.subject}`;
    if (copies.has(key)) return false;
    copies.add(key);
    return true;
  });

  // 3. An edit is covered by a later commit of the same session that lists its file.
  // `latest` maps sessionId to file path to the latest commit `t`, so each edit is one
  // lookup. `files` are relative to `toplevel`.
  const latest = new Map();
  for (const c of commitRows) {
    let byFile = latest.get(c.sessionId);
    if (!byFile) latest.set(c.sessionId, (byFile = new Map()));
    for (const f of c.files) {
      const abs = c.toplevel ? `${c.toplevel}/${f}` : f;
      if ((byFile.get(abs) ?? -Infinity) < c.t) byFile.set(abs, c.t);
    }
  }
  const covered = (e) => e.file != null && e.t != null && (latest.get(e.sessionId)?.get(e.file) ?? -Infinity) >= e.t;

  const rows = [];
  for (const e of edits) if (!covered(e)) rows.push({ sessionId: e.sessionId, t: e.t, added: e.added, removed: e.removed, repo: e.repo });
  for (const c of commitRows) rows.push({ sessionId: c.sessionId, t: c.t, added: c.added, removed: c.removed, repo: c.repo });
  return rows;
}

module.exports = { lineRows };
