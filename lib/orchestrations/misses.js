'use strict';

const { ms, taskNumber } = require('./events');

// Commits that landed on a passed task's files after the task merged, found from the
// run's event log and the plan branch's git log. A candidate is a lead for a human or
// the final review to classify: later work on a shared file can match too.

// The commits in the output of `git log --no-merges --name-only --format=%H%x09%ct%x09%s`.
function parseGitLog(text) {
  const commits = [];
  for (const line of text.split('\n')) {
    const head = /^([0-9a-f]+)\t(\d+)\t(.*)$/.exec(line);
    if (head) commits.push({ sha: head[1], t: Number(head[2]) * 1000, subject: head[3], files: [] });
    else if (line !== '' && commits.length) commits[commits.length - 1].files.push(line);
  }
  return commits;
}

// The time after which a commit on the task's files counts as late: its first `merged`,
// else its last `review-pass`, else null.
function lateAfter(events, n) {
  const own = events.filter((e) => taskNumber(e) === n);
  const merged = own.find((e) => e.kind === 'merged');
  if (merged) return ms(merged);
  const passes = own.filter((e) => e.kind === 'review-pass');
  return passes.length ? ms(passes[passes.length - 1]) : null;
}

// Task M's window, from its first `claimed` to its first `merged`. Null without a `merged`.
function windowOf(events, m) {
  const own = events.filter((e) => taskNumber(e) === m);
  const claimed = own.find((e) => e.kind === 'claimed');
  const merged = own.find((e) => e.kind === 'merged');
  return claimed && merged ? [ms(claimed), ms(merged)] : null;
}

function lateCommits({ events, tasks, commits }) {
  const numbers = Object.keys(tasks).map(Number).filter((n) => n !== 0);
  const windows = new Map(numbers.map((n) => [n, windowOf(events, n)]));
  const out = [];
  for (const n of numbers) {
    const after = lateAfter(events, n);
    if (after === null) continue;
    for (const c of commits) {
      if (c.t <= after) continue;
      const files = c.files.filter((f) => tasks[n].includes(f));
      if (files.length === 0) continue;
      const inside = numbers.some((m) => {
        const w = windows.get(m);
        return m !== n && w && c.t >= w[0] && c.t <= w[1] && c.files.some((f) => tasks[m].includes(f));
      });
      if (!inside) out.push({ task: n, sha: c.sha, subject: c.subject, files });
    }
  }
  return out;
}

module.exports = { parseGitLog, lateCommits, windowOf };
