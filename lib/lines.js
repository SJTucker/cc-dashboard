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
  for (const c of commits) if (!bySha.has(c.sha)) bySha.set(c.sha, c);
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
  // time, author and subject. One copy counts, the one with the earliest `t`.
  // `kept` is sorted by `t`, so the first row seen for a key is the earliest.
  const copies = new Set();
  const commitRows = kept.filter((c) => {
    if (dropped.has(c)) return false;
    if (c.authorTime == null || c.authorEmail == null) return true;
    const key = `${c.authorTime}\0${c.authorEmail}\0${c.subject}`;
    if (copies.has(key)) return false;
    copies.add(key);
    return true;
  });

  // 3. An edit is covered by a later commit of the same session that lists its file.
  const covered = (e) =>
    e.file != null &&
    e.t != null &&
    commitRows.some((c) => c.sessionId === e.sessionId && c.t >= e.t && c.files.includes(e.file));

  const rows = [];
  for (const e of edits) if (!covered(e)) rows.push({ sessionId: e.sessionId, t: e.t, added: e.added, removed: e.removed, repo: e.repo });
  for (const c of commitRows) rows.push({ sessionId: c.sessionId, t: c.t, added: c.added, removed: c.removed, repo: c.repo });
  return rows;
}

module.exports = { lineRows };
