'use strict';

const { relative, isAbsolute, sep } = require('node:path');

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

  // 2. A row read from the reflog (`fromReflog`) is a commit that no ref reaches. A row
  // with `rewrite` is a rebased or cherry-picked copy whose author time left the window.
  // Another row may count the same work, so such a row is dropped when a row of the same
  // repo that is neither of the two (a counted row) has the same (authorTime,
  // authorEmail, subject), the same patchId, or the same subject and authorEmail with at
  // least one file in common. It is also dropped when every one of its files appears in
  // counted rows of the same repo with authorTime at or after its own and `t` at or
  // before its own: a squash repeats the files of the commits it squashed, and
  // `commit -C <first>` keeps the first commit's author time, so the others are later.
  // A row with no files is never dropped by that test. A rewrite row is eligible only
  // when its authorEmail is its committerEmail, or is the authorEmail of a counted row in
  // the repo, so a teammate's commit that a session cherry-picked never counts. A row with
  // no twin is the only record of its work and counts. A dropped row is not output, is
  // not an original for `amendOf` or the subtraction, and covers no edit. The test runs
  // over every row after the sha dedupe (`kept`), so a patch-id copy of a dropped row is
  // dropped by the same twin, not kept as a later original.
  const twinA = new Set();
  const twinP = new Set();
  const twinFiles = new Map();
  const authors = new Set();
  // repo -> file -> [{ at, t }] sorted by `at`, with `minT[i]` the least `t` from i on.
  const byFile = new Map();
  for (const c of kept) {
    if (c.fromReflog || c.rewrite) continue;
    twinA.add(`${c.repo}\0${c.authorTime}\0${c.authorEmail}\0${c.subject}`);
    if (c.patchId) twinP.add(`${c.repo}\0${c.patchId}`);
    if (c.authorEmail != null) authors.add(`${c.repo}\0${c.authorEmail}`);
    const k = `${c.repo}\0${c.authorEmail}\0${c.subject}`;
    if (!twinFiles.has(k)) twinFiles.set(k, new Set());
    for (const f of c.files) twinFiles.get(k).add(f);
    if (c.squash || c.authorTime == null) continue;
    const files = byFile.get(c.repo) ?? byFile.set(c.repo, new Map()).get(c.repo);
    for (const f of new Set(c.files)) (files.get(f) ?? files.set(f, []).get(f)).push({ at: c.authorTime, t: c.t });
  }
  for (const files of byFile.values()) {
    for (const list of files.values()) {
      list.sort((a, b) => a.at - b.at);
      for (let i = list.length - 1; i >= 0; i--) list[i].minT = Math.min(list[i].t, list[i + 1]?.minT ?? Infinity);
    }
  }
  const coveredBy = (c) => {
    const files = byFile.get(c.repo);
    if (!files || !c.files.length || c.authorTime == null) return false;
    return c.files.every((f) => {
      const list = files.get(f);
      if (!list) return false;
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].at < c.authorTime) lo = mid + 1;
        else hi = mid;
      }
      return lo < list.length && list[lo].minT <= c.t;
    });
  };
  const reflogDropped = new Set();
  const candidates = kept.filter((c) => {
    if (!c.fromReflog && !c.rewrite) return true;
    const shared = twinFiles.get(`${c.repo}\0${c.authorEmail}\0${c.subject}`);
    const ineligible = c.rewrite && !(c.authorEmail != null && (c.authorEmail === c.committerEmail || authors.has(`${c.repo}\0${c.authorEmail}`)));
    const dup = ineligible
      || (c.authorTime != null && c.authorEmail != null && twinA.has(`${c.repo}\0${c.authorTime}\0${c.authorEmail}\0${c.subject}`))
      || (c.patchId && twinP.has(`${c.repo}\0${c.patchId}`))
      || (!!shared && c.files.some((f) => shared.has(f)))
      || coveredBy(c);
    if (dup) reflogDropped.add(c);
    return !dup;
  });

  // 2b. A rebase or cherry-pick copies a commit under a new sha. One copy counts, the
  // one with the earliest `t` (`candidates` is sorted by `t`, so the first row seen wins).
  // A row with a patchId is keyed by (repo, patchId). A row without one uses
  // (repo, authorTime, authorEmail, subject) and skips amends, because an amend in a
  // later session shares those fields with the commit it rewrote.
  const seen = new Set();
  const unique = candidates.filter((c) => {
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
  // A row step 2 dropped as a copy is still a candidate original: an amend of the
  // copy's checkout finds it in `droppedAt`. A dropped row is never output.
  const uniqueSet = new Set(unique);
  const keyOf = (c) => (c.authorTime == null || c.authorEmail == null
    ? null
    : `${c.toplevel ?? c.repo}\0${c.parent}\0${c.authorTime}\0${c.authorEmail}`);
  const droppedAt = new Map();
  for (const c of kept) {
    const k = keyOf(c);
    if (!uniqueSet.has(c) && !reflogDropped.has(c) && k && (droppedAt.get(k)?.t ?? -Infinity) <= c.t) droppedAt.set(k, c);
  }
  const shaRows = new Set(kept.filter((c) => !reflogDropped.has(c)).map((c) => c.sha));
  const latestAt = new Map();
  const counted = [];
  for (const c of unique) {
    const key = keyOf(c);
    let added = c.added;
    let removed = c.removed;
    if (c.amend) {
      // The reflog delta applies only when the original has a row. The amended-away
      // original is unreachable, so a re-extract usually has no row for it, and the
      // delta alone would lose the original's lines.
      if (c.amendOf && shaRows.has(c.amendOf.sha)) {
        added = c.amendOf.added;
        removed = c.amendOf.removed;
      } else {
        const a = key && latestAt.get(key);
        const d = key && droppedAt.get(key);
        // The latest original with t at or before the amend wins.
        const orig = [a, d].filter((o) => o && o !== c && o.t <= c.t).sort((x, y) => y.t - x.t)[0];
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
  //   byRoot: `${root ?? toplevel}\0${file}`. `root` is set on a fallback commit and
  //     names the removed worktree whose paths the commit lists.
  //   byRepo: `${repo}\0${file}`, for a migrated fallback commit with no `root`.
  //   byAbs: absolute path, for an edit row without `root`.
  const index = new Map();
  const bump = (m, k, t) => { if ((m.get(k) ?? -Infinity) < t) m.set(k, t); };
  for (const { c } of counted) {
    let s = index.get(c.sessionId);
    if (!s) index.set(c.sessionId, (s = { byRoot: new Map(), byRepo: new Map(), byAbs: new Map() }));
    for (const f of c.files) {
      if (c.fallback && !c.root) bump(s.byRepo, `${c.repo}\0${f}`, c.t);
      else {
        const top = c.root ?? c.toplevel;
        if (top) bump(s.byRoot, `${top}\0${f}`, c.t);
        if (!c.fallback) bump(s.byAbs, c.toplevel ? `${c.toplevel}/${f}` : f, c.t);
      }
    }
  }
  const covered = (e) => {
    const s = index.get(e.sessionId);
    if (!s || e.file == null || e.t == null) return false;
    const abs = (s.byAbs.get(e.file) ?? -Infinity) >= e.t;
    if (!e.root) return abs;
    const rel = relative(e.root, e.file);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return abs;
    return (s.byRoot.get(`${e.root}\0${rel}`) ?? -Infinity) >= e.t
      || (s.byRepo.get(`${e.repo}\0${rel}`) ?? -Infinity) >= e.t;
  };

  const rows = [];
  for (const e of edits) if (!covered(e)) rows.push({ sessionId: e.sessionId, t: e.t, added: e.added, removed: e.removed, repo: e.repo });
  for (const { c, added, removed } of counted) rows.push({ sessionId: c.sessionId, t: c.t, added, removed, repo: c.repo });
  return rows;
}

module.exports = { lineRows };
