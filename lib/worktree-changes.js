'use strict';

// Which files changed in a worker's worktree, found with git, for the DRIFT check of
// `bin/transcript-index --watch --run`. It sees edits made through Bash (sed -i, a
// heredoc, a script), which the transcript's Edit and Write steps do not show.

const path = require('path');
const { execFileSync } = require('child_process');

// git's output in the worktree, or null when git fails or takes over 5 s. The watch
// skips a poll on null rather than stopping.
function gitOut(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Absolute paths, sorted: tracked files that differ from head, committed or not,
// deletions included, and untracked files git does not ignore. Null when git fails.
function changedSince(worktree, head) {
  const tracked = gitOut(worktree, ['diff', '--name-only', '--no-renames', '-z', head]);
  const untracked = tracked === null ? null : gitOut(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked === null) return null;
  const names = new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean));
  return [...names].sort().map((f) => path.join(worktree, f));
}

// The worktree's HEAD when a watch starts, and the files already changed then. The
// watch reports only files that changed later, so a re-armed watch does not repeat
// what the last one saw. Null when git fails.
function worktreeBase(worktree) {
  const head = gitOut(worktree, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return null;
  const before = changedSince(worktree, head);
  return before === null ? null : { head, before: new Set(before) };
}

module.exports = { changedSince, worktreeBase };
