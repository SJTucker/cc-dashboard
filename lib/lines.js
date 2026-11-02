'use strict';

// The line rows behind the lines totals: Edit and Write rows plus commit rows.
// A session's edits and the commit that records them describe the same lines, so
// lineRows counts them once, from the commit.
//
// Known limits: commit `files` for non-ASCII names come back octal-quoted, and a
// commit resolved through the deleted-worktree fallback lists main-checkout paths.
// In both cases the edit is not matched and its lines count twice.

// edits: { toolUseId, t, sessionId, added, removed, repo, file }
// commits: { sha, parent, added, removed, files, repo, amend, t, sessionId }
// Returns [{ sessionId, t, added, removed, repo }].
function lineRows(edits, commits) {
  // 1. One row per sha, because a commit seen in two transcripts is one commit.
  const bySha = new Map();
  for (const c of commits) if (!bySha.has(c.sha)) bySha.set(c.sha, c);
  const kept = [...bySha.values()].sort((a, b) => a.t - b.t);

  // 2. An amend replaces the latest earlier commit of its session and repo that has
  // the same parent. A non-amend commit with that parent is a sibling, so it stays.
  const dropped = new Set();
  for (const c of kept) {
    if (!c.amend) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      const p = kept[i];
      if (p === c || dropped.has(p) || p.t > c.t) continue;
      if (p.sessionId === c.sessionId && p.repo === c.repo && p.parent === c.parent) {
        dropped.add(p);
        break;
      }
    }
  }
  const commitRows = kept.filter((c) => !dropped.has(c));

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
